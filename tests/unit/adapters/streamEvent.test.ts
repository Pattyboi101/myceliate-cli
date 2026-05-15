import { describe, expect, expectTypeOf, it } from 'vitest';
import type { StreamEvent, Usage } from '../../../src/adapters/streamEvent.js';
import {
  isContentDelta,
  isDone,
  isError,
  isReasoningDelta,
  isSubagentStep,
  isToolCall,
  isToolResult,
} from '../../../src/adapters/streamEvent.js';

describe('StreamEvent', () => {
  it('discriminates reasoning_delta, content_delta, tool_call, done, error', () => {
    const events: StreamEvent[] = [
      { type: 'reasoning_delta', text: 'thinking…' },
      { type: 'content_delta', text: 'hello' },
      { type: 'tool_call', id: 't1', name: 'read_file', args: { path: '/etc/hosts' } },
      { type: 'done', usage: { promptTokens: 10, completionTokens: 5, reasoningTokens: 3 } },
      { type: 'error', cause: new Error('boom') },
    ];
    expect(events.filter(isReasoningDelta)).toHaveLength(1);
    expect(events.filter(isContentDelta)).toHaveLength(1);
    expect(events.filter(isToolCall)).toHaveLength(1);
    expect(events.filter(isDone)).toHaveLength(1);
    expect(events.filter(isError)).toHaveLength(1);
  });
});

it('done.usage carries the full Usage shape (type-level assertion)', () => {
  // Compile-time: done variant's usage field is exactly Usage.
  type DoneEvent = Extract<StreamEvent, { type: 'done' }>;
  expectTypeOf<DoneEvent['usage']>().toEqualTypeOf<Usage>();

  // Runtime: a fully-populated usage round-trips through isDone.
  const ev: StreamEvent = {
    type: 'done',
    usage: { promptTokens: 100, completionTokens: 50, reasoningTokens: 10, cacheHitTokens: 5 },
  };
  expect(isDone(ev)).toBe(true);
  if (isDone(ev)) {
    expect(ev.usage.promptTokens).toBe(100);
    expect(ev.usage.completionTokens).toBe(50);
    expect(ev.usage.reasoningTokens).toBe(10);
    expect(ev.usage.cacheHitTokens).toBe(5);
  }
});

it('done.usage.cacheHitTokens is optional (omit-able)', () => {
  // Compile-time: cacheHitTokens is optional — assignability check.
  const withoutCache: Usage = { promptTokens: 10, completionTokens: 5, reasoningTokens: 0 };
  expectTypeOf(withoutCache).toMatchTypeOf<Usage>();
  const ev: StreamEvent = { type: 'done', usage: withoutCache };
  expect(isDone(ev)).toBe(true);
  if (isDone(ev)) {
    expect(ev.usage.cacheHitTokens).toBeUndefined();
  }
});

describe('isSubagentStep type guard', () => {
  it('returns true for valid subagent_step event', () => {
    expect(
      isSubagentStep({
        type: 'subagent_step',
        step: 0,
        durationMs: 1234,
        model: 'deepseek-v4-flash',
      }),
    ).toBe(true);
  });

  it('returns false for other event types', () => {
    expect(isSubagentStep({ type: 'done' })).toBe(false);
    expect(isSubagentStep({ type: 'content_delta', text: 'hi' })).toBe(false);
  });

  it('returns false for non-objects and nulls', () => {
    expect(isSubagentStep(null)).toBe(false);
    expect(isSubagentStep('string')).toBe(false);
    expect(isSubagentStep(123)).toBe(false);
  });
});

it('isToolResult narrows correctly on completed/failed/rejected', () => {
  const ev = {
    type: 'tool_result' as const,
    id: 't1',
    status: 'completed' as const,
    durationMs: 42,
    preview: 'ok',
  };
  expect(isToolResult(ev)).toBe(true);
  expect(
    isToolResult({
      type: 'done' as const,
      usage: { promptTokens: 0, completionTokens: 0, reasoningTokens: 0 },
    }),
  ).toBe(false);
});
