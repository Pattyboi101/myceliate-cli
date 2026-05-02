import { describe, it, expect } from 'vitest';
import type { StreamEvent } from '../../../src/adapters/streamEvent.js';
import { isToolCall, isContentDelta, isReasoningDelta, isDone } from '../../../src/adapters/streamEvent.js';

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
  });
});
