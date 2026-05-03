// tests/unit/memory/conversationLog.test.ts
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConversationLog } from '../../../src/memory/conversationLog.js';
import { MarkdownStore } from '../../../src/memory/markdownStore.js';

describe('ConversationLog redaction (Task 81a)', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'myc-conv-redact-'));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  async function readSessionFile(sessionId: string): Promise<string> {
    return readFile(join(tmp, 'history', `${sessionId}.md`), 'utf8');
  }

  it('redacts secrets in user content', async () => {
    const store = new MarkdownStore(tmp);
    const log = new ConversationLog(store, 'sess-user');
    await log.appendTurn({
      role: 'user',
      content: 'here is my key OPENAI_API_KEY=sk-abcdef1234567890abcdef',
    });
    const out = await readSessionFile('sess-user');
    expect(out).not.toContain('sk-abcdef1234567890abcdef');
    expect(out).toContain('[REDACTED:');
  });

  it('redacts secrets in assistant content and reasoning_content', async () => {
    const store = new MarkdownStore(tmp);
    const log = new ConversationLog(store, 'sess-asst');
    await log.appendTurn({
      role: 'assistant',
      content: 'use OPENAI_API_KEY=sk-realLooking1234567890abcdef',
      reasoning_content: 'thinking about TOKEN=t-abcdefghijklmnopqrstuvwxyz',
    });
    const out = await readSessionFile('sess-asst');
    expect(out).not.toContain('sk-realLooking1234567890abcdef');
    expect(out).not.toContain('t-abcdefghijklmnopqrstuvwxyz');
    expect(out).toContain('[REDACTED:');
  });

  it('redacts secrets inside tool_call arg leaves (not the JSON envelope)', async () => {
    const store = new MarkdownStore(tmp);
    const log = new ConversationLog(store, 'sess-tc');
    await log.appendTurn({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'c1',
          name: 'bash',
          args: { command: 'export DEEPSEEK_API_KEY=sk-veryreal1234567890abcdef && echo done' },
        },
      ],
    });
    const out = await readSessionFile('sess-tc');
    expect(out).not.toContain('sk-veryreal1234567890abcdef');
    expect(out).toContain('[REDACTED:');
    // The JSON envelope is preserved (parses).
    const match = out.match(/bash\((\{.*\})\)/);
    expect(match).toBeTruthy();
    if (match?.[1]) expect(() => JSON.parse(match[1] as string)).not.toThrow();
  });

  it('redacts secrets in tool result content', async () => {
    const store = new MarkdownStore(tmp);
    const log = new ConversationLog(store, 'sess-tr');
    await log.appendTurn({
      role: 'tool',
      result: {
        tool_use_id: 'c1',
        command: 'env',
        is_error: false,
        content: 'OPENAI_API_KEY=sk-realLooking1234567890abcdef\nOTHER=plain',
      },
    });
    const out = await readSessionFile('sess-tr');
    expect(out).not.toContain('sk-realLooking1234567890abcdef');
    expect(out).toContain('[REDACTED:');
    expect(out).toContain('OTHER=plain');
  });

  it('passes non-secret content through verbatim', async () => {
    const store = new MarkdownStore(tmp);
    const log = new ConversationLog(store, 'sess-clean');
    await log.appendTurn({ role: 'user', content: 'hello world, no secrets here' });
    const out = await readSessionFile('sess-clean');
    expect(out).toContain('hello world, no secrets here');
    expect(out).not.toContain('[REDACTED:');
  });
});
