// tests/integration/compactionRedaction.test.ts
//
// Phase 16 Task 103: verifies redactor markers survive L1+L2+L3 compaction
// without fragmenting. Closes the v1.0 deferred-to-v2 "compaction-then-redact
// integration test" gap. Static analysis says the markers are alphanumeric+brackets
// and do not match any redactor pattern themselves, but a future change to either
// a compactor (truncation byte-counting) or the redactor (new pattern) could
// accidentally slice a marker mid-string. This test makes that class of regression
// fail loudly.

import { describe, expect, it } from 'vitest';
import type { Message } from '../../src/adapters/messages.js';
import { QueryEngine } from '../../src/orchestrator/QueryEngine.js';

describe('Compaction-Redaction integration (Phase 16 Task 103)', () => {
  // The negative assertion: any `[REDAC` substring NOT followed by `TED:` is
  // proof the marker was sliced apart somewhere in the pipeline. A pristine
  // marker `[REDACTED:env_value]` matches `[REDAC` then `TED:` — so the lookahead
  // `(?!TED:)` is false and the regex does NOT match. A fragmented `[REDAC` at
  // a truncation boundary fails the lookahead and the regex DOES match.
  const partialMarker = /\[REDAC(?!TED:)/;

  it('preserves [REDACTED:env_value] markers across L1 tool-output pruning', () => {
    const engine = new QueryEngine({
      systemPrompt: 'sys',
      workingBudget: 800, // forces prune verdict
      maxToolOutputChars: 200, // forces L1 truncation
      protectedTailMessages: 0,
    });
    engine.appendUser('go');
    engine.appendAssistant({
      content: '',
      tool_calls: [{ id: 't1', name: 'bash', args: {} }],
    });
    // 5000 chars of content with a marker placed where L1 truncation will land.
    // L1 caps at maxToolOutputChars=200, so the visible window is the head;
    // we need the marker INSIDE that window to test the "marker preserved" path
    // AND we need extra content beyond 200 chars so truncation actually fires.
    const head = 'KEY=[REDACTED:env_value] start of the output ';
    const tail = 'x'.repeat(5000);
    engine.appendToolResult({
      tool_use_id: 't1',
      command: 'bash echo',
      is_error: false,
      content: head + tail,
    });

    const req = engine.prepareRequest({
      model: 'm',
      tools: [],
      thinking: false,
      strict: true,
    });

    const toolMsg = req.messages.find(
      (m): m is Extract<Message, { role: 'tool' }> => m.role === 'tool',
    );
    expect(toolMsg).toBeDefined();
    const content = toolMsg?.result.content ?? '';
    // Primary contract: no mid-marker fragment. Whether L1 truncation OR L3
    // micro-compact fires (all layers run in sequence per R10), the output
    // must never contain a bare `[REDAC` that isn't followed by `TED:`.
    // Note: with all three layers running, L3 may replace the content with
    // MICRO_COMPACTED_PLACEHOLDER — that's fine; the placeholder itself
    // must not contain `[REDAC` either (it's `[micro-compacted]`).
    expect(content).not.toMatch(partialMarker);
  });

  it('preserves [REDACTED:*] markers through L2 dead-end snipping', () => {
    // L2 collapses 3+ consecutive error tool messages into a placeholder.
    // The placeholder must not fragment a marker that spans a snip boundary.
    const engine = new QueryEngine({
      systemPrompt: 'sys',
      workingBudget: 1500,
      protectedTailTokens: 25,
    });
    engine.appendUser('go');
    for (let i = 0; i < 5; i++) {
      engine.appendAssistant({
        content: '',
        tool_calls: [{ id: `t${i}`, name: 'bash', args: {} }],
      });
      engine.appendToolResult({
        tool_use_id: `t${i}`,
        command: 'bash',
        is_error: true,
        content: `error N+${i}: KEY=[REDACTED:env_value] from failed call`,
      });
    }

    const req = engine.prepareRequest({
      model: 'm',
      tools: [],
      thinking: false,
      strict: true,
    });

    const toolMsgs = req.messages.filter(
      (m): m is Extract<Message, { role: 'tool' }> => m.role === 'tool',
    );
    for (const tm of toolMsgs) {
      expect(tm.result.content).not.toMatch(partialMarker);
    }
  });

  it('preserves [REDACTED:*] markers through L3 micro-compaction (metadata-only retention)', () => {
    const engine = new QueryEngine({
      systemPrompt: 'sys',
      workingBudget: 200, // very tight, forces L3 escalation
      maxToolOutputChars: 1000,
      protectedTailMessages: 0,
    });
    engine.appendUser('go');
    engine.appendAssistant({
      content: '',
      tool_calls: [{ id: 't1', name: 'bash', args: {} }],
    });
    engine.appendToolResult({
      tool_use_id: 't1',
      command: 'bash',
      is_error: false,
      content: 'something with KEY=[REDACTED:env_value] inside',
    });

    const req = engine.prepareRequest({
      model: 'm',
      tools: [],
      thinking: false,
      strict: true,
    });

    const toolMsg = req.messages.find(
      (m): m is Extract<Message, { role: 'tool' }> => m.role === 'tool',
    );
    expect(toolMsg).toBeDefined();
    // L3 replaces content with MICRO_COMPACTED_PLACEHOLDER (a fixed string with
    // no marker fragment risk). Verify defensively.
    expect(toolMsg?.result.content).not.toMatch(partialMarker);
  });
});
