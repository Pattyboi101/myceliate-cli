// tests/unit/memory/conversationLog.test.ts
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Message } from '../../../src/adapters/messages.js';
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

describe('ConversationLog JSONL sidecar + readSession (Phase 18)', () => {
  let tmp: string;
  let store: MarkdownStore;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'myc-conv-resume-'));
    store = new MarkdownStore(tmp);
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('writes both .md and .jsonl on each appendTurn', async () => {
    const log = new ConversationLog(store, 'sess1');
    await log.appendTurn({ role: 'user', content: 'hello' });
    await log.appendTurn({ role: 'assistant', content: 'hi there' });

    const md = await readFile(join(tmp, 'history', 'sess1.md'), 'utf8');
    expect(md).toContain('### user');
    expect(md).toContain('hello');

    const jsonl = await readFile(join(tmp, 'history', 'sess1.jsonl'), 'utf8');
    const lines = jsonl.trim().split('\n');
    expect(lines).toHaveLength(2);
    const line0 = lines[0];
    const line1 = lines[1];
    if (!line0 || !line1) throw new Error('expected 2 lines');
    expect(JSON.parse(line0)).toEqual({ role: 'user', content: 'hello' });
    expect(JSON.parse(line1)).toEqual({ role: 'assistant', content: 'hi there' });
  });

  it('redacts secrets in JSONL just like the .md (round-trip preserves redaction)', async () => {
    const log = new ConversationLog(store, 'sess2');
    await log.appendTurn({
      role: 'user',
      content: 'set OPENAI_API_KEY=sk-realLooking1234567890abcdef',
    });
    const jsonl = await readFile(join(tmp, 'history', 'sess2.jsonl'), 'utf8');
    expect(jsonl).not.toContain('sk-realLooking1234567890abcdef');
    expect(jsonl).toContain('[REDACTED:');
  });

  it('readSession round-trips messages from the JSONL', async () => {
    const log = new ConversationLog(store, 'sess3');
    await log.appendTurn({ role: 'user', content: 'first' });
    await log.appendTurn({
      role: 'assistant',
      content: 'second',
      reasoning_content: 'thinking',
      tool_calls: [{ id: 't1', name: 'bash', args: { command: 'ls' } }],
    });
    await log.appendTurn({
      role: 'tool',
      result: {
        tool_use_id: 't1',
        command: 'bash {"command":"ls"}',
        is_error: false,
        content: 'README.md',
      },
    });

    const messages = await ConversationLog.readSession(store, 'sess3');
    expect(messages).toHaveLength(3);
    expect(messages[0]?.role).toBe('user');
    expect(messages[1]?.role).toBe('assistant');
    expect(messages[2]?.role).toBe('tool');
    if (messages[1]?.role === 'assistant') {
      expect(messages[1].tool_calls).toHaveLength(1);
      expect(messages[1].tool_calls?.[0]?.id).toBe('t1');
    }
  });

  it('readSession returns empty array when the session does not exist', async () => {
    const messages = await ConversationLog.readSession(store, 'no-such-session');
    expect(messages).toEqual([]);
  });

  it('readSession skips malformed JSONL lines and continues parsing', async () => {
    const dir = join(tmp, 'history');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'sess4.jsonl'),
      `{"role":"user","content":"a"}\n<<< not json >>>\n{"role":"user","content":"b"}\n`,
      'utf8',
    );
    const messages = await ConversationLog.readSession(store, 'sess4');
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe('user');
    expect((messages[0] as { content: string }).content).toBe('a');
    expect((messages[1] as { content: string }).content).toBe('b');
  });

  // Phase 18 review m1: assistant content fidelity. Locks the
  // `m.content !== null` redactMessage guard against a regression to
  // truthy-check (which would collapse content: '' into content: null).
  it('round-trips assistant content distinctions: empty string stays empty, null stays null', async () => {
    const log = new ConversationLog(store, 'sess-fidelity');
    // Empty-string content (the runtime state of a tool-call-only assistant
    // turn — assistantContent starts at '' and never receives a content_delta).
    await log.appendTurn({
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 't1', name: 'bash', args: { cmd: 'ls' } }],
    });
    // Genuine null content.
    await log.appendTurn({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 't2', name: 'bash', args: { cmd: 'pwd' } }],
    });

    const messages = await ConversationLog.readSession(store, 'sess-fidelity');
    expect(messages).toHaveLength(2);
    // Empty string survives as empty string (NOT collapsed to null).
    expect(messages[0]?.role).toBe('assistant');
    expect((messages[0] as { content: string | null }).content).toBe('');
    // Null survives as null.
    expect(messages[1]?.role).toBe('assistant');
    expect((messages[1] as { content: string | null }).content).toBeNull();
  });

  // Phase 18 review MINOR-1 (R11 parity): the result.command field is
  // constructed in reactLoop.ts as `${call.name} ${JSON.stringify(call.args)}`
  // — raw LLM-provided args. The .md path (renderTurn) drops it entirely;
  // the JSONL is the FIRST persistent channel that carries it, so it must
  // be redacted on the way to disk to match egress + .md effective parity.
  it('redacts secrets in tool result.command (matches egress / .md parity)', async () => {
    const log = new ConversationLog(store, 'sess-cmd');
    await log.appendTurn({
      role: 'tool',
      result: {
        tool_use_id: 't1',
        // Simulate a command string that carries an env-style secret.
        command:
          'bash {"command":"export OPENAI_API_KEY=sk-realLooking1234567890abcdef && echo done"}',
        is_error: false,
        content: 'done',
      },
    });
    const messages = await ConversationLog.readSession(store, 'sess-cmd');
    expect(messages).toHaveLength(1);
    const tool = messages[0] as Extract<Message, { role: 'tool' }>;
    expect(tool.role).toBe('tool');
    expect(tool.result.command).not.toContain('sk-realLooking1234567890abcdef');
    expect(tool.result.command).toContain('[REDACTED:');
  });

  // Round-trip a tool message with is_error: true (previously only is_error: false
  // was exercised in the round-trip path).
  it('round-trips tool result with is_error: true preserving the error flag', async () => {
    const log = new ConversationLog(store, 'sess-err');
    await log.appendTurn({
      role: 'tool',
      result: {
        tool_use_id: 't1',
        command: 'bash',
        is_error: true,
        content: 'spawn ENOENT',
      },
    });
    const messages = await ConversationLog.readSession(store, 'sess-err');
    expect(messages).toHaveLength(1);
    const tool = messages[0] as Extract<Message, { role: 'tool' }>;
    expect(tool.role).toBe('tool');
    expect(tool.result.is_error).toBe(true);
    expect(tool.result.content).toBe('spawn ENOENT');
  });
});
