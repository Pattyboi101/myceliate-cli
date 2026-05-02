import { describe, expect, it } from 'vitest';
import type { Message } from '../../../src/adapters/messages.js';
import { hasReasoningContent, hasToolCalls } from '../../../src/adapters/messages.js';

describe('Message', () => {
  it('detects assistant messages with tool calls (R2: reasoning_content must be retained)', () => {
    const m: Message = {
      role: 'assistant',
      content: '',
      reasoning_content: 'I should read the file first',
      tool_calls: [{ id: 't1', name: 'read_file', args: { path: 'a.txt' } }],
    };
    expect(hasToolCalls(m)).toBe(true);
    expect(hasReasoningContent(m)).toBe(true);
  });

  it('flags assistant messages without tool calls (R2: reasoning_content can be discarded)', () => {
    const m: Message = { role: 'assistant', content: 'final answer' };
    expect(hasToolCalls(m)).toBe(false);
    expect(hasReasoningContent(m)).toBe(false);
  });
});
