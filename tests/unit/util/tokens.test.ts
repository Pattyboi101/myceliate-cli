// tests/unit/util/tokens.test.ts
import { describe, expect, it } from 'vitest';
import { estimateMessageTokens, estimateTokens } from '../../../src/util/tokens.js';

describe('token estimator (coarse)', () => {
  it('estimates ~chars/4 for plain text', () => {
    expect(estimateTokens('hello world')).toBe(Math.ceil('hello world'.length / 4));
  });

  it('estimates assistant message including reasoning_content and tool_calls JSON', () => {
    const t = estimateMessageTokens({
      role: 'assistant',
      content: 'ok',
      reasoning_content: 'thinking…',
      tool_calls: [{ id: 't', name: 'x', args: { a: 1 } }],
    });
    expect(t).toBeGreaterThan(estimateTokens('ok'));
  });

  // Extra cases beyond the plan

  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('scales linearly with text length', () => {
    const a = estimateTokens('x'.repeat(400));
    const b = estimateTokens('x'.repeat(800));
    expect(b).toBe(a * 2);
  });

  it('tool message includes both command and content token counts', () => {
    const command = 'read_file big.txt';
    const content = 'y'.repeat(1000);
    const t = estimateMessageTokens({
      role: 'tool',
      result: { tool_use_id: 't1', command, is_error: false, content },
    });
    expect(t).toBeGreaterThan(estimateTokens(content));
    expect(t).toBeGreaterThan(estimateTokens(command));
  });

  it('assistant with no reasoning_content and no tool_calls returns estimateTokens(content) + 4 exactly', () => {
    const content = 'hello world';
    const t = estimateMessageTokens({ role: 'assistant', content });
    expect(t).toBe(estimateTokens(content) + 4);
  });

  it('assistant with null content counts as 0 chars for content', () => {
    const t = estimateMessageTokens({ role: 'assistant', content: null });
    expect(t).toBe(4);
  });
});
