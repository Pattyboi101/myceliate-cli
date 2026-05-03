// tests/unit/orchestrator/QueryEngine.test.ts
import { describe, expect, it } from 'vitest';
import type { Message } from '../../../src/adapters/messages.js';
import { QueryEngine } from '../../../src/orchestrator/QueryEngine.js';

const t = (id: string, content: string): Message => ({
  role: 'tool',
  result: { tool_use_id: id, command: 'cmd', is_error: false, content },
});

describe('QueryEngine', () => {
  it('appends and exposes the history', () => {
    const q = new QueryEngine({ systemPrompt: 'sys', workingBudget: 10_000 });
    q.appendUser('hi');
    const req = q.prepareRequest({ model: 'm', tools: [], thinking: true, strict: true });
    expect(req.messages.at(0)).toEqual({ role: 'system', content: 'sys' });
    expect(req.messages.at(-1)).toEqual({ role: 'user', content: 'hi' });
  });

  it('R2: retains reasoning_content on assistant turns that include tool_calls', () => {
    const q = new QueryEngine({ systemPrompt: 'sys', workingBudget: 10_000 });
    q.appendAssistant({
      content: '',
      reasoning_content: 'I should call a tool',
      tool_calls: [{ id: 't1', name: 'x', args: {} }],
    });
    q.appendToolResult({ tool_use_id: 't1', command: 'cmd', is_error: false, content: 'ok' });
    const req = q.prepareRequest({ model: 'm', tools: [], thinking: true, strict: true });
    const asst = req.messages.find((m) => m.role === 'assistant');
    expect(asst).toMatchObject({ reasoning_content: 'I should call a tool' });
  });

  it('R2: discards reasoning_content from purely conversational assistant turns', () => {
    const q = new QueryEngine({ systemPrompt: 'sys', workingBudget: 10_000 });
    q.appendAssistant({ content: 'final answer', reasoning_content: 'noise' });
    const req = q.prepareRequest({ model: 'm', tools: [], thinking: true, strict: true });
    const asst = req.messages.find((m) => m.role === 'assistant');
    expect(asst).not.toHaveProperty('reasoning_content');
  });

  it('runs compaction when budget exceeds prune threshold', () => {
    // Design: workingBudget=800, prune at 50% (400 tokens), refuse at 95% (760 tokens).
    // 'x'.repeat(2_400) → 600 content tokens + overhead → ~612 tokens total (above 400, below 760).
    // maxToolOutputChars=200 truncates the 2_400 char payload.
    // protectedTailMessages=0 ensures no messages are protected from L1 pruning.
    const q = new QueryEngine({
      systemPrompt: 'sys',
      workingBudget: 800,
      maxToolOutputChars: 200,
      protectedTailMessages: 0,
      thresholds: {
        pruneThresholdPct: 50,
        snipThresholdPct: 70,
        microThresholdPct: 90,
        refusalThresholdPct: 95,
      },
    });
    q.appendToolResult({
      tool_use_id: 't',
      command: 'read_file big.log',
      is_error: false,
      content: 'x'.repeat(2_400),
    });
    q.appendUser('continue');
    const req = q.prepareRequest({ model: 'm', tools: [], thinking: true, strict: true });
    const tool = req.messages.find((m) => m.role === 'tool');
    if (tool?.role !== 'tool') throw new Error('no tool');
    expect(tool.result.content).toContain('[truncated');
  });

  // --- Additional contract cases per lesson #5 ---

  it('prepareRequest twice produces consistent system message at index 0', () => {
    const q = new QueryEngine({ systemPrompt: 'sys', workingBudget: 10_000 });
    q.appendUser('first');
    const req1 = q.prepareRequest({ model: 'm', tools: [], thinking: true, strict: true });
    q.appendAssistant({ content: 'answer' });
    q.appendUser('second');
    const req2 = q.prepareRequest({ model: 'm', tools: [], thinking: true, strict: true });
    expect(req1.messages.at(0)).toEqual({ role: 'system', content: 'sys' });
    expect(req2.messages.at(0)).toEqual({ role: 'system', content: 'sys' });
  });

  it('applyR2 does not mutate the underlying history', () => {
    const q = new QueryEngine({ systemPrompt: 'sys', workingBudget: 10_000 });
    q.appendAssistant({ content: 'done', reasoning_content: 'private thoughts' });
    // capture snapshot before prepare
    const snapBefore = q.snapshot();
    const beforeMsg = snapBefore.find((m) => m.role === 'assistant');
    if (beforeMsg?.role !== 'assistant') throw new Error('no assistant');
    const hadReasoning = 'reasoning_content' in beforeMsg;

    // prepareRequest should strip R2 on the working copy but not the stored history
    q.prepareRequest({ model: 'm', tools: [], thinking: true, strict: true });

    const snapAfter = q.snapshot();
    const afterMsg = snapAfter.find((m) => m.role === 'assistant');
    if (afterMsg?.role !== 'assistant') throw new Error('no assistant');
    expect(hadReasoning).toBe(true);
    expect('reasoning_content' in afterMsg).toBe(true);
  });

  it('appendToolResult accepts full ToolResult shape', () => {
    const q = new QueryEngine({ systemPrompt: 'sys', workingBudget: 10_000 });
    q.appendToolResult({
      tool_use_id: 'x1',
      command: 'bash ls',
      is_error: false,
      content: 'file1',
    });
    const snap = q.snapshot();
    const msg = snap.find((m) => m.role === 'tool');
    if (msg?.role !== 'tool') throw new Error('no tool result');
    expect(msg.result).toMatchObject({
      tool_use_id: 'x1',
      command: 'bash ls',
      is_error: false,
      content: 'file1',
    });
  });

  it("prepareRequest with 'refuse' action throws CompactionRefusal", () => {
    const q = new QueryEngine({
      systemPrompt: 'sys',
      workingBudget: 100,
      thresholds: {
        pruneThresholdPct: 1,
        snipThresholdPct: 2,
        microThresholdPct: 3,
        refusalThresholdPct: 4,
      },
    });
    // add enough content to exceed refusal threshold
    q.appendToolResult({
      tool_use_id: 't',
      command: 'read',
      is_error: false,
      content: 'x'.repeat(50_000),
    });
    q.appendUser('go');
    expect(() => q.prepareRequest({ model: 'm', tools: [], thinking: true, strict: true })).toThrow(
      expect.objectContaining({ kind: 'compaction_refused' }),
    );
  });

  it('threshold defaults are applied when only workingBudget is supplied', () => {
    // constructing with just workingBudget should not throw (default thresholds are valid)
    expect(() => new QueryEngine({ systemPrompt: 'sys', workingBudget: 10_000 })).not.toThrow();
  });

  // Use the unused t helper to prevent lint warning
  it('t helper produces expected shape', () => {
    const msg = t('id1', 'content1');
    expect(msg).toEqual({
      role: 'tool',
      result: { tool_use_id: 'id1', command: 'cmd', is_error: false, content: 'content1' },
    });
  });
});
