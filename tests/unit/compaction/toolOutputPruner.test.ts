// tests/unit/compaction/toolOutputPruner.test.ts
import { describe, expect, it } from 'vitest';
import type { Message } from '../../../src/adapters/messages.js';
import { pruneToolOutputs } from '../../../src/orchestrator/compaction/toolOutputPruner.js';

const tool = (id: string, command: string, content: string): Message => ({
  role: 'tool',
  result: { tool_use_id: id, command, is_error: false, content },
});

describe('pruneToolOutputs', () => {
  it('truncates oversized tool result content but preserves metadata', () => {
    const big = 'x'.repeat(50_000);
    const history: Message[] = [{ role: 'user', content: 'go' }, tool('t1', 'cat huge.log', big)];
    const out = pruneToolOutputs(history, { maxToolOutputChars: 1000, protectedTailMessages: 0 });
    const pruned = out[1];
    if (pruned?.role !== 'tool') throw new Error('not tool');
    expect(pruned.result.content.length).toBeLessThan(big.length);
    expect(pruned.result.content).toContain('[truncated');
    expect(pruned.result.command).toBe('cat huge.log');
  });

  it('does not touch tool results within the protected tail', () => {
    const big = 'x'.repeat(50_000);
    const history: Message[] = [tool('t1', 'cmd', big)];
    const out = pruneToolOutputs(history, { maxToolOutputChars: 1000, protectedTailMessages: 5 });
    expect((out[0] as Extract<Message, { role: 'tool' }>).result.content).toBe(big);
  });

  it('deduplicates identical read_file results, keeping the most recent', () => {
    const history: Message[] = [
      tool('t1', 'read_file a.txt', 'contents-A-v1'),
      { role: 'assistant', content: 'thinking' },
      tool('t2', 'read_file a.txt', 'contents-A-v2'),
    ];
    const out = pruneToolOutputs(history, {
      maxToolOutputChars: 100_000,
      protectedTailMessages: 0,
    });
    const tools = out.filter((m): m is Extract<Message, { role: 'tool' }> => m.role === 'tool');
    expect(tools).toHaveLength(1);
    expect(tools[0]?.result.content).toBe('contents-A-v2');
  });

  // Extra cases beyond the plan

  it('read_file dedup with 3+ duplicates keeps only the latest', () => {
    const history: Message[] = [
      tool('t1', 'read_file foo.ts', 'v1'),
      tool('t2', 'read_file foo.ts', 'v2'),
      tool('t3', 'read_file foo.ts', 'v3'),
    ];
    const out = pruneToolOutputs(history, {
      maxToolOutputChars: 100_000,
      protectedTailMessages: 0,
    });
    const tools = out.filter((m): m is Extract<Message, { role: 'tool' }> => m.role === 'tool');
    expect(tools).toHaveLength(1);
    expect(tools[0]?.result.content).toBe('v3');
  });

  it('protectedTailMessages counts from the END — 5-msg history with tail=2 protects last 2', () => {
    const big = 'x'.repeat(50_000);
    const history: Message[] = [
      tool('t1', 'cmd1', big), // index 0 — NOT protected
      tool('t2', 'cmd2', big), // index 1 — NOT protected
      { role: 'user', content: 'a' }, // index 2 — NOT protected
      tool('t3', 'cmd3', big), // index 3 — protected (within last 2)
      tool('t4', 'cmd4', big), // index 4 — protected (within last 2)
    ];
    const out = pruneToolOutputs(history, { maxToolOutputChars: 1000, protectedTailMessages: 2 });
    // t1 and t2 should be truncated; t3 and t4 should be preserved
    const t1 = out[0] as Extract<Message, { role: 'tool' }>;
    const t2 = out[1] as Extract<Message, { role: 'tool' }>;
    const t3 = out[3] as Extract<Message, { role: 'tool' }>;
    const t4 = out[4] as Extract<Message, { role: 'tool' }>;
    expect(t1.result.content).toContain('[truncated');
    expect(t2.result.content).toContain('[truncated');
    expect(t3.result.content).toBe(big);
    expect(t4.result.content).toBe(big);
  });

  it('tool result exactly at maxToolOutputChars is NOT truncated (boundary)', () => {
    const content = 'z'.repeat(1000);
    const history: Message[] = [tool('t1', 'cmd', content)];
    const out = pruneToolOutputs(history, { maxToolOutputChars: 1000, protectedTailMessages: 0 });
    expect((out[0] as Extract<Message, { role: 'tool' }>).result.content).toBe(content);
  });

  it('[truncated] marker reports the correct original length', () => {
    const original = 'a'.repeat(5000);
    const history: Message[] = [tool('t1', 'cmd', original)];
    const out = pruneToolOutputs(history, { maxToolOutputChars: 100, protectedTailMessages: 0 });
    const result = (out[0] as Extract<Message, { role: 'tool' }>).result.content;
    expect(result).toContain('[truncated: original 5000 chars]');
  });

  it('idempotence: re-pruning already-truncated content does not stack markers or drift the original-count annotation', () => {
    // Without the idempotence guard, a second L1 pass would re-truncate the
    // already-truncated content (length ~ maxToolOutputChars + marker overhead)
    // and overwrite the recorded `original 5000 chars` with a smaller drifted count.
    const original = 'a'.repeat(5000);
    const history: Message[] = [tool('t1', 'cmd', original)];
    const opts = { maxToolOutputChars: 100, protectedTailMessages: 0 };
    const once = pruneToolOutputs(history, opts);
    const twice = pruneToolOutputs(once, opts);
    const onceContent = (once[0] as Extract<Message, { role: 'tool' }>).result.content;
    const twiceContent = (twice[0] as Extract<Message, { role: 'tool' }>).result.content;
    // After the guard: second pass is a no-op — content is byte-identical, the
    // `original 5000 chars` annotation is preserved.
    expect(twiceContent).toBe(onceContent);
    expect(twiceContent).toContain('[truncated: original 5000 chars]');
  });

  it('read_file dedup is zone-agnostic — older duplicate dropped even when both copies are in the protected tail', () => {
    // Documents that dedup wins over zone protection: a stale `read_file` output
    // from an earlier turn is dropped even if both copies fall inside the
    // protectedTailMessages window. Only the latest copy is retained.
    const history: Message[] = [
      tool('t1', 'read_file foo.ts', 'v1'),
      tool('t2', 'read_file foo.ts', 'v2'),
    ];
    const out = pruneToolOutputs(history, {
      maxToolOutputChars: 100_000,
      protectedTailMessages: 2, // protects both
    });
    const tools = out.filter((m): m is Extract<Message, { role: 'tool' }> => m.role === 'tool');
    expect(tools).toHaveLength(1);
    expect(tools[0]?.result.content).toBe('v2');
  });
});
