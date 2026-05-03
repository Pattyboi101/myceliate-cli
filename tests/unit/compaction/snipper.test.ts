// tests/unit/compaction/snipper.test.ts
import { describe, expect, it } from 'vitest';
import type { Message } from '../../../src/adapters/messages.js';
import { snipDeadEnds } from '../../../src/orchestrator/compaction/snipper.js';

const u = (s: string): Message => ({ role: 'user', content: s });
const a = (s: string): Message => ({ role: 'assistant', content: s });
const errTool = (id: string): Message => ({
  role: 'tool',
  result: { tool_use_id: id, command: 'cmd', is_error: true, content: 'err' },
});
const okTool = (id: string): Message => ({
  role: 'tool',
  result: { tool_use_id: id, command: 'cmd', is_error: false, content: 'ok' },
});

describe('snipDeadEnds', () => {
  it('protects the system message and the most recent N tokens', () => {
    const history: Message[] = [
      { role: 'system', content: 'rules' },
      u('first'),
      errTool('t1'),
      errTool('t2'),
      errTool('t3'),
      a('giving up on that approach'),
      u('latest'),
    ];
    const out = snipDeadEnds(history, { protectedTailTokens: 1000 });
    expect(out[0]?.role).toBe('system');
    expect(out.at(-1)).toEqual(u('latest'));
  });

  it('removes runs of >= 3 consecutive errored tool results from the middle', () => {
    // history indices: 0=u('start'), 1-4=errTools, 5=a, 6=okTool, 7=u('done')
    // Token counts per message:
    //   u('done')             = ceil(4/4)+4 = 1+4 = 5
    //   okTool('t5')          = ceil(2/4)+ceil(3/4)+8 = 1+1+8 = 10
    //   a('switching...')     = ceil(19/4)+4 = 5+4 = 9
    //   errTool('t4')         = 10
    //   errTool('t3')         = 10
    //   errTool('t2')         = 10
    //   errTool('t1')         = 10
    // Walking backward from end, protect last 3 messages (u, okTool, a) = 5+10+9 = 24 tokens
    // With protectedTailTokens=25, after u(5) acc=5, okTool(10) acc=15, a(9) acc=24 < 25,
    // next errTool('t4') brings acc=34 >= 25 => protectedFrom = 4 (errTool t4 is protected)
    // So unprotected: 0,1,2,3 => errTools at 1,2,3 form a run of 3 => snipped!
    const history: Message[] = [
      u('start'),
      errTool('t1'),
      errTool('t2'),
      errTool('t3'),
      errTool('t4'),
      a('switching strategy'),
      okTool('t5'),
      u('done'),
    ];
    const out = snipDeadEnds(history, { protectedTailTokens: 25 });
    const errors = out.filter((m) => m.role === 'tool' && m.result.is_error);
    expect(errors.length).toBeLessThan(4);
  });

  it('never snips messages within the protected tail', () => {
    const history: Message[] = [
      u('start'),
      errTool('t1'),
      errTool('t2'),
      errTool('t3'),
      u('latest'),
    ];
    // Set protectedTailTokens huge so the whole history is protected.
    const out = snipDeadEnds(history, { protectedTailTokens: 100_000 });
    expect(out).toEqual(history);
  });

  // Extra cases beyond the plan

  it('error run of exactly 3 IS snipped (boundary)', () => {
    // u('end') = ceil(3/4)+4 = 1+4 = 5 tokens
    // protectedTailTokens=5: walking back, acc=5 >= 5 => protectedFrom=4 (u('end') is index 4)
    // so indices 0..3 unprotected; errTools at 1,2,3 => run of 3 => snipped
    const history: Message[] = [u('start'), errTool('t1'), errTool('t2'), errTool('t3'), u('end')];
    const out = snipDeadEnds(history, { protectedTailTokens: 5 });
    const errors = out.filter((m) => m.role === 'tool' && m.result.is_error);
    expect(errors).toHaveLength(0);
    // Should have a snip marker
    const snipMarkers = out.filter((m) => m.role === 'system' && m.content.includes('[snipped'));
    expect(snipMarkers).toHaveLength(1);
  });

  it('error run of exactly 2 is NOT snipped', () => {
    const history: Message[] = [u('start'), errTool('t1'), errTool('t2'), u('end')];
    const out = snipDeadEnds(history, { protectedTailTokens: 10 });
    const errors = out.filter((m) => m.role === 'tool' && m.result.is_error);
    expect(errors).toHaveLength(2);
  });

  it('error run straddling protected boundary — only unprotected errors are snipped', () => {
    // indices: 0=u, 1=errTool, 2=errTool, 3=errTool, 4=errTool, 5=u
    // protected from index 3 onward (last 3 messages: 3,4,5)
    // So indices 1,2 are unprotected. That's only a run of 2 => NOT snipped (< 3)
    const history: Message[] = [
      u('start'),
      errTool('t1'), // index 1 — unprotected
      errTool('t2'), // index 2 — unprotected
      errTool('t3'), // index 3 — protected
      errTool('t4'), // index 4 — protected
      u('end'), // index 5 — protected
    ];
    // Make protectedTailTokens cover last 3 msgs: t3 + t4 + 'end'
    // Each errTool = estimateTokens('err') + estimateTokens('cmd') + 8 = 1+1+8 = 10
    // u('end') = estimateTokens('end') + 4 = 1+4 = 5
    // total last 3 = 10+10+5 = 25 tokens
    const out = snipDeadEnds(history, { protectedTailTokens: 25 });
    const errors = out.filter((m) => m.role === 'tool' && m.result.is_error);
    // t1, t2 are unprotected but only form a run of 2 — not snipped
    expect(errors).toHaveLength(4); // all 4 error tools remain (2 unprotected + 2 protected)
  });

  it('non-error tool results are never snipped even if consecutive', () => {
    const history: Message[] = [
      u('start'),
      okTool('t1'),
      okTool('t2'),
      okTool('t3'),
      okTool('t4'),
      u('end'),
    ];
    const out = snipDeadEnds(history, { protectedTailTokens: 10 });
    const okTools = out.filter((m) => m.role === 'tool' && !m.result.is_error);
    expect(okTools).toHaveLength(4);
  });
});
