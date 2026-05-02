import { describe, expect, it } from 'vitest';
import { serializeArgs } from '../../../src/adapters/v4/adapter.js';
import { DsmlParser, escapeXml, unescapeXml } from '../../../src/adapters/v4/dsmlParser.js';

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

describe('DsmlParser — DSML escape contract', () => {
  it('unescapes XML entities in string param values', () => {
    const p = new DsmlParser();
    const events = p.feed(
      '<|DSML|tool_calls><call id="t" name="x"><param key="sql" string="true">a &lt; b AND c &gt; d</param></call></|DSML|tool_calls>',
    );
    expect(events).toContainEqual({
      type: 'tool_call',
      id: 't',
      name: 'x',
      args: { sql: 'a < b AND c > d' },
    });
  });

  it('unescapes attribute values (id, name, key)', () => {
    const p = new DsmlParser();
    const events = p.feed(
      '<|DSML|tool_calls><call id="t&amp;1" name="run&lt;x&gt;"><param key="a&quot;b" string="true">v</param></call></|DSML|tool_calls>',
    );
    expect(events).toContainEqual({
      type: 'tool_call',
      id: 't&1',
      name: 'run<x>',
      args: { 'a"b': 'v' },
    });
  });

  it('does not lose params with literal "<" inside string-mode value (was C1 silent drop)', () => {
    const p = new DsmlParser();
    // Pre-escape on the wire (the serializer's job); parser must round-trip.
    const escaped = `<|DSML|tool_calls><call id="t" name="x"><param key="html" string="true">${escapeXml('<div>x</div>')}</param></call></|DSML|tool_calls>`;
    const events = p.feed(escaped);
    expect(events).toContainEqual({
      type: 'tool_call',
      id: 't',
      name: 'x',
      args: { html: '<div>x</div>' },
    });
  });

  it.each([
    { name: 'plain string', args: { s: 'plain' } },
    { name: 'string with quotes', args: { s: 'with "quote" and \'apos\'' } },
    { name: 'string with angle brackets', args: { s: 'a < b > c' } },
    { name: 'string with HTML', args: { s: '<div class="x">y</div>' } },
    { name: 'string with ampersand', args: { msg: 'one & two' } },
    { name: 'number', args: { n: 5 } },
    { name: 'boolean', args: { b: true } },
    { name: 'array of mixed', args: { arr: [1, 'two', { three: 3 }] } },
    { name: 'nested object', args: { nested: { a: 'b', c: 'd<e>' } } },
    { name: 'null value', args: { v: null } },
    { name: 'empty object', args: {} },
  ])('round-trips serializeArgs → parser for $name', ({ args }) => {
    const wire = `<|DSML|tool_calls><call id="t" name="x">${serializeArgs(args)}</call></|DSML|tool_calls>`;
    const events = new DsmlParser().feed(wire);
    const toolCall = events.find((e) => e.type === 'tool_call');
    expect(toolCall).toMatchObject({ id: 't', name: 'x', args });
  });
});

describe('DsmlParser — buffer advancement (regression for the spec bug)', () => {
  it('does not re-emit param value bytes when the close arrives in a later feed', () => {
    const p = new DsmlParser();
    const events = [
      ...p.feed('<|DSML|tool_calls><call id="t" name="x"><param key="k" string="true">'),
      ...p.feed('a'),
      ...p.feed('b'),
      ...p.feed('c'),
      ...p.feed('</param></call></|DSML|tool_calls>'),
    ];
    const calls = events.filter((e) => e.type === 'tool_call');
    expect(calls).toEqual([{ type: 'tool_call', id: 't', name: 'x', args: { k: 'abc' } }]);
  });
});

describe('DsmlParser — flush()', () => {
  it('emits remaining content-mode buffer at end of stream', () => {
    const p = new DsmlParser();
    // The safe-prefix logic withholds bytes that could start an OPEN_BLOCK.
    const initial = p.feed('tail<|D');
    expect(initial).toEqual([{ type: 'content_delta', text: 'tail' }]); // '<|D' withheld
    const drained = p.flush();
    expect(drained).toEqual([{ type: 'content_delta', text: '<|D' }]);
  });

  it('drops incomplete block-mode bytes (refuses to emit half-formed tool calls)', () => {
    const p = new DsmlParser();
    p.feed('<|DSML|tool_calls><call id="t" name="x"><param key="k" string="true">val');
    expect(p.flush()).toEqual([]);
  });

  it('returns nothing when content buffer is empty', () => {
    const p = new DsmlParser();
    p.feed('hello\n\n');
    expect(p.flush()).toEqual([]);
  });
});

describe('escapeXml / unescapeXml', () => {
  it('round-trips the five entity characters', () => {
    const original = `< > & " '`;
    expect(unescapeXml(escapeXml(original))).toBe(original);
  });

  it('leaves benign text untouched', () => {
    expect(escapeXml('hello world')).toBe('hello world');
    expect(unescapeXml('hello world')).toBe('hello world');
  });

  it('escapeXml handles all five entities', () => {
    expect(escapeXml('<>&"\'')).toBe('&lt;&gt;&amp;&quot;&apos;');
  });
});
