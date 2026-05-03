// src/memory/conversationLog.ts
import type { Message } from '../adapters/messages.js';
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

  private path(): string {
    return `history/${this.sessionId}.md`;
  }

  async appendTurn(message: Message): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.store.write(
        this.path(),
        { sessionId: this.sessionId, started: new Date().toISOString() },
        '',
      );
    }
    await this.initPromise;
    const block = renderTurn(message);
    await this.store.append(this.path(), block);
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
