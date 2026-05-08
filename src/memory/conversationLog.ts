// src/memory/conversationLog.ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AssistantMessage, Message } from '../adapters/messages.js';
import { redactJsonLeaves, redactSecrets } from '../security/redactor.js';
import type { MarkdownStore } from './markdownStore.js';

/**
 * Append-only log of a single agent session, persisted as
 * `.myceliate/history/<sessionId>.md`.
 *
 * Initialization is captured in a Promise<void> rather than a boolean:
 * concurrent appendTurn calls on a fresh instance race past a boolean
 * guard (both pass `if (!flag)`, both call store.write which truncates
 * the file). Holding a Promise lets the second caller await the same
 * write that the first kicked off — no double-truncate, no data loss.
 *
 * NOTE: This race lives within a single instance. If two ConversationLog
 * instances point at the same sessionId both will still attempt to write
 * the frontmatter header. Acceptable for v1 (single orchestrator → single
 * ConversationLog per session).
 */
export class ConversationLog {
  private initPromise: Promise<void> | null = null;
  constructor(
    private readonly store: MarkdownStore,
    private readonly sessionId: string,
  ) {}

  private mdPath(): string {
    return `history/${this.sessionId}.md`;
  }

  private jsonlPath(): string {
    return `history/${this.sessionId}.jsonl`;
  }

  async appendTurn(message: Message): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.store.write(
        this.mdPath(),
        { sessionId: this.sessionId, started: new Date().toISOString() },
        '',
      );
    }
    await this.initPromise;
    const block = renderTurn(message);
    await this.store.append(this.mdPath(), block);

    // Phase 18: JSONL sidecar — same redaction passes as .md, structured for
    // round-trip. We redact at the field level (matching renderTurn's per-field
    // calls) before serialising so the on-disk JSON does not carry cleartext
    // secrets. Does NOT serialize approvalRequests or approvalResolvers — those
    // live in AppState / src/index.ts and are NOT part of the canonical Message
    // struct (Phase 17 carry-forward #1).
    //
    // Phase 18 review m4: the .md and .jsonl appends are SEQUENTIAL `await`s,
    // not atomic. If the .md write succeeds but the .jsonl write fails (disk
    // full, fs error mid-write), the two files drift out of sync — the .md
    // has the turn but readSession won't see it on resume. Acceptable in v1.2
    // (single-user, append-only logs); v1.3 may add a crash-recovery path
    // that detects truncation and falls back to re-synthesising .jsonl from
    // the .md (non-trivial because renderTurn's Markdown is not round-trippable
    // back to Message[] — that's the original motivation for the .jsonl).
    const redacted = redactMessage(message);
    await this.store.append(this.jsonlPath(), `${JSON.stringify(redacted)}\n`);
  }

  /**
   * Read a prior session's structured JSONL and reconstruct the Message[]
   * for QueryEngine rehydration. Returns [] if the session file is missing.
   * Malformed JSON lines are skipped (defensive — the .jsonl is append-only
   * but a partial-write or manual edit shouldn't crash resume).
   */
  static async readSession(store: MarkdownStore, sessionId: string): Promise<Message[]> {
    const path = join(store.baseDir, 'history', `${sessionId}.jsonl`);
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch {
      return [];
    }
    const messages: Message[] = [];
    for (const line of text.split('\n')) {
      if (line.length === 0) continue;
      try {
        messages.push(JSON.parse(line) as Message);
      } catch {
        // Skip malformed lines — partial-write or hand-edit should not crash resume.
      }
    }
    return messages;
  }
}

/**
 * Apply the same redaction passes that renderTurn does, but at the field level
 * before JSON serialisation, so the .jsonl carries the same R11 guarantees as
 * the .md. Pure helper — does not mutate the input. Does NOT touch
 * approvalRequests or approvalResolvers (those are AppState / closure state,
 * not part of the canonical Message struct — Phase 17 carry-forward #1).
 *
 * Phase 18 review n3: keep redaction policy in sync with `renderTurn` below.
 * If you add a new pattern to `redactSecrets` or change which fields get
 * redacted, update BOTH this function and renderTurn — they target the same
 * threat model (egress vs disk parity) via different output formats.
 *
 * Phase 18 review m1 (fidelity fix): the assistant `content` field is
 * `string | null` per `AssistantMessage`. Naive truthy-check `m.content ? ... : null`
 * collapses `''` (the runtime state of a tool-call-only turn — `reactLoop.ts`
 * starts `assistantContent = ''` and never receives a `content_delta`) into
 * `null`, breaking round-trip fidelity. Use explicit `!== null` so empty
 * string survives as empty string and only the genuine `null` becomes `null`.
 *
 * Phase 18 review MINOR-1 (R11 parity fix): `result.command` is constructed
 * in `reactLoop.ts` as `${call.name} ${JSON.stringify(call.args)}` — raw
 * LLM-provided args. The .md path (`renderTurn`) never includes `command`,
 * so this field is invisible there. The JSONL is the FIRST persistent channel
 * that carries it. Apply `redactSecrets` to maintain parity with the .md's
 * effective behaviour (no unredacted egress channel for command).
 */
function redactMessage(m: Message): Message {
  switch (m.role) {
    case 'system':
    case 'user':
      return { role: m.role, content: m.content ? redactSecrets(m.content) : '' };
    case 'assistant': {
      const out: AssistantMessage = {
        role: 'assistant',
        content: m.content !== null ? redactSecrets(m.content) : null,
      };
      if (m.reasoning_content) out.reasoning_content = redactSecrets(m.reasoning_content);
      if (m.tool_calls?.length) {
        out.tool_calls = m.tool_calls.map((tc) => ({
          id: tc.id,
          name: tc.name,
          args: redactJsonLeaves(tc.args),
        }));
      }
      return out;
    }
    case 'tool':
      return {
        role: 'tool',
        result: {
          tool_use_id: m.result.tool_use_id,
          command: redactSecrets(m.result.command),
          is_error: m.result.is_error,
          content: redactSecrets(m.result.content),
        },
      };
  }
}

function renderTurn(m: Message): string {
  switch (m.role) {
    case 'system':
    case 'user':
    case 'assistant': {
      // Task 81a: redact every cleartext channel before disk write so
      // `.myceliate/history/<session>.md` carries the same R11 guarantees as
      // egress payloads. Tool-call args are walked per-leaf (redactJsonLeaves)
      // because the env_value pattern's greedy `\S+` would otherwise consume
      // the closing `}` of the JSON envelope when applied to the assembled
      // string — matching F1's adapter-level treatment.
      const content = m.content ? redactSecrets(m.content) : '';
      const reasoning =
        m.role === 'assistant' && m.reasoning_content
          ? `\n<details><summary>reasoning</summary>\n\n${redactSecrets(m.reasoning_content)}\n\n</details>\n`
          : '';
      const tools =
        m.role === 'assistant' && m.tool_calls?.length
          ? `\n\n**tool_calls:** ${m.tool_calls
              .map((tc) => `${tc.name}(${JSON.stringify(redactJsonLeaves(tc.args))})`)
              .join(', ')}\n`
          : '';
      return `\n\n### ${m.role}\n\n${content}${reasoning}${tools}`;
    }
    case 'tool':
      return `\n\n### tool (${m.result.tool_use_id}) ${m.result.is_error ? 'ERROR' : 'OK'}\n\n\`\`\`\n${redactSecrets(m.result.content)}\n\`\`\``;
  }
}
