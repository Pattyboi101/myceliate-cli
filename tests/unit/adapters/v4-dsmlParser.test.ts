import { describe, expect, it } from 'vitest';
import { DsmlParser } from '../../../src/adapters/v4/dsmlParser.js';

describe('DsmlParser — happy path', () => {
  it('extracts a single tool call with mixed string/structured params', () => {
    const p = new DsmlParser();
    const events = [
      ...p.feed('<|DSML|tool_calls>'),
      ...p.feed('<call id="t1" name="bash">'),
      ...p.feed('<param key="cmd" string="true">echo "hi"</param>'),
      ...p.feed('<param key="timeout" string="false">5000</param>'),
      ...p.feed('</call>'),
      ...p.feed('</|DSML|tool_calls>'),
    ];
    expect(events).toEqual([
      { type: 'tool_call', id: 't1', name: 'bash', args: { cmd: 'echo "hi"', timeout: 5000 } },
    ]);
  });

  it('preserves text outside DSML markers as content', () => {
    const p = new DsmlParser();
    const events = [
      ...p.feed('Some thinking text. '),
      ...p.feed('<|DSML|tool_calls><call id="x" name="ls"></call></|DSML|tool_calls>'),
      ...p.feed(' Trailing.'),
    ];
    expect(events).toContainEqual({ type: 'content_delta', text: 'Some thinking text. ' });
    expect(events).toContainEqual({ type: 'tool_call', id: 'x', name: 'ls', args: {} });
    expect(events).toContainEqual({ type: 'content_delta', text: ' Trailing.' });
  });

  it('handles markers split across feeds', () => {
    const p = new DsmlParser();
    const events = [
      ...p.feed('<|DSML|tool_'),
      ...p.feed('calls><call id="a" name="b"></call></|DSML|tool_calls>'),
    ];
    expect(events).toContainEqual({ type: 'tool_call', id: 'a', name: 'b', args: {} });
  });

  it('handles structured array param', () => {
    const p = new DsmlParser();
    const events = [
      ...p.feed('<|DSML|tool_calls><call id="t" name="x">'),
      ...p.feed('<param key="paths" string="false">["a","b"]</param>'),
      ...p.feed('</call></|DSML|tool_calls>'),
    ];
    expect(events).toContainEqual({
      type: 'tool_call',
      id: 't',
      name: 'x',
      args: { paths: ['a', 'b'] },
    });
  });
});
