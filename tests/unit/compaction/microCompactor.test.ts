// tests/unit/compaction/microCompactor.test.ts
import { describe, expect, it } from 'vitest';
import type { Message } from '../../../src/adapters/messages.js';
import { microCompact } from '../../../src/orchestrator/compaction/microCompactor.js';

const tool = (id: string, command: string, content: string, isError = false): Message => ({
  role: 'tool',
  result: { tool_use_id: id, command, is_error: isError, content },
});

describe('microCompact', () => {
  it('clears tool result content but preserves tool_use_id, command, is_error', () => {
    const history: Message[] = [
      tool('t1', 'bash echo a', 'aaaaaaaaaaaaaaa'.repeat(100)),
      { role: 'assistant', content: 'next' },
    ];
    const out = microCompact(history, { protectedTailMessages: 0 });
    const collapsed = out[0];
    if (collapsed?.role !== 'tool') throw new Error('expected tool');
    expect(collapsed.result.tool_use_id).toBe('t1');
    expect(collapsed.result.command).toBe('bash echo a');
    expect(collapsed.result.is_error).toBe(false);
    expect(collapsed.result.content).toBe('[micro-compacted]');
  });

  it('preserves error status verbatim while still clearing content', () => {
    const out = microCompact([tool('t1', 'cmd', 'fail trace', true)], {
      protectedTailMessages: 0,
    });
    expect((out[0] as Extract<Message, { role: 'tool' }>).result.is_error).toBe(true);
    expect((out[0] as Extract<Message, { role: 'tool' }>).result.content).toBe('[micro-compacted]');
  });

  it('does not touch tool results in the protected tail', () => {
    const history: Message[] = [tool('t1', 'cmd', 'keep me')];
    const out = microCompact(history, { protectedTailMessages: 5 });
    expect((out[0] as Extract<Message, { role: 'tool' }>).result.content).toBe('keep me');
  });

  // Extra cases beyond the plan

  it('non-tool messages pass through unchanged', () => {
    const history: Message[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
      { role: 'system', content: 'sys' },
    ];
    const out = microCompact(history, { protectedTailMessages: 0 });
    expect(out).toEqual(history);
  });

  it('[micro-compacted] placeholder is exactly that string', () => {
    const out = microCompact([tool('t1', 'cmd', 'some output')], { protectedTailMessages: 0 });
    const result = (out[0] as Extract<Message, { role: 'tool' }>).result.content;
    expect(result).toBe('[micro-compacted]');
  });

  it('idempotent: calling microCompact twice is a no-op on the second call', () => {
    const history: Message[] = [tool('t1', 'cmd', 'big output here')];
    const once = microCompact(history, { protectedTailMessages: 0 });
    const twice = microCompact(once, { protectedTailMessages: 0 });
    expect(twice).toEqual(once);
    expect((twice[0] as Extract<Message, { role: 'tool' }>).result.content).toBe(
      '[micro-compacted]',
    );
  });
});
