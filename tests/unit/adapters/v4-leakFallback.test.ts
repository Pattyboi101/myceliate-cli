import { describe, it, expect } from 'vitest';
import { detectLeakedDsml } from '../../../src/adapters/v4/leakFallback.js';

describe('detectLeakedDsml', () => {
  it('detects DSML markers leaked into a content stream', () => {
    const result = detectLeakedDsml('Some text <|DSML|tool_calls><call id="t1" name="bash"><param key="cmd" string="true">ls</param></call></|DSML|tool_calls>');
    expect(result).toEqual({
      cleanedText: 'Some text ',
      toolCalls: [{ id: 't1', name: 'bash', args: { cmd: 'ls' } }],
    });
  });

  it('returns null toolCalls when no leak present', () => {
    const result = detectLeakedDsml('Just normal text.');
    expect(result.toolCalls).toEqual([]);
    expect(result.cleanedText).toBe('Just normal text.');
  });

  it('handles multiple leaked tool calls', () => {
    const result = detectLeakedDsml('<|DSML|tool_calls><call id="a" name="x"></call><call id="b" name="y"></call></|DSML|tool_calls>');
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0]?.id).toBe('a');
    expect(result.toolCalls[1]?.id).toBe('b');
  });
});
