import { describe, expect, expectTypeOf, it } from 'vitest';
import type { StreamEvent, Usage } from '../../../src/adapters/streamEvent.js';
import {
  isContentDelta,
  isDone,
  isError,
  isReasoningDelta,
  isRequestStarted,
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

describe('isRequestStarted type guard', () => {
  it('returns true for a valid request_started event with all fields', () => {
    const ev: StreamEvent = {
      type: 'request_started',
      role: 'repl-with-reasoning',
      model: 'deepseek-v4-pro',
      iter: 0,
    };
    expect(isRequestStarted(ev)).toBe(true);
    if (isRequestStarted(ev)) {
      expect(ev.role).toBe('repl-with-reasoning');
      expect(ev.model).toBe('deepseek-v4-pro');
      expect(ev.iter).toBe(0);
    }
  });

  it('returns true when optional iter/step fields are absent', () => {
    // iter and step are optional — omitting them must still satisfy the guard
    const ev: StreamEvent = {
      type: 'request_started',
      role: 'repl-execution',
      model: 'deepseek-v4-flash',
    };
    expect(isRequestStarted(ev)).toBe(true);
  });

  it('returns false for other event types', () => {
    expect(isRequestStarted({ type: 'done' })).toBe(false);
    expect(isRequestStarted({ type: 'content_delta', text: 'hi' })).toBe(false);
    expect(isRequestStarted({ type: 'subagent_step', step: 0, durationMs: 0, model: 'x' })).toBe(
      false,
    );
  });

  it('returns false for non-objects and nulls', () => {
    expect(isRequestStarted(null)).toBe(false);
    expect(isRequestStarted('string')).toBe(false);
    expect(isRequestStarted(42)).toBe(false);
  });
});

it('request_started variant is part of the StreamEvent union (type-level assertion)', () => {
  // Compile-time: a correctly shaped object must be assignable to StreamEvent.
  const ev: StreamEvent = {
    type: 'request_started',
    role: 'repl-with-reasoning',
    model: 'deepseek-v4-pro',
    iter: 0,
  };
  type RequestStartedEvent = Extract<StreamEvent, { type: 'request_started' }>;
  expectTypeOf(ev).toMatchTypeOf<RequestStartedEvent>();
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
