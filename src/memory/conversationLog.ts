// src/memory/conversationLog.ts
import type { Message } from '../adapters/messages.js';
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
      // AssistantMessage.content may be null when the turn is purely a tool call.
      const content = m.content ?? '';
      const reasoning =
        m.role === 'assistant' && m.reasoning_content
          ? `\n<details><summary>reasoning</summary>\n\n${m.reasoning_content}\n\n</details>\n`
          : '';
      const tools =
        m.role === 'assistant' && m.tool_calls?.length
          ? `\n\n**tool_calls:** ${m.tool_calls.map((tc) => `${tc.name}(${JSON.stringify(tc.args)})`).join(', ')}\n`
          : '';
      return `\n\n### ${m.role}\n\n${content}${reasoning}${tools}`;
    }
    case 'tool':
      return `\n\n### tool (${m.result.tool_use_id}) ${m.result.is_error ? 'ERROR' : 'OK'}\n\n\`\`\`\n${m.result.content}\n\`\`\``;
  }
}
