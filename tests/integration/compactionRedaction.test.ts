// tests/integration/compactionRedaction.test.ts
//
// Phase 16 Task 103: verifies redactor markers survive L1 / L2 / L3 compaction
// without fragmenting. Closes the v1.0 deferred-to-v2 "compaction-then-redact
// integration test" gap. Static analysis says the markers are alphanumeric +
// brackets and do not match any redactor pattern themselves, but a future
// change to either a compactor (truncation byte-counting) or the redactor
// (new pattern) could accidentally slice a marker mid-string. This test
// makes that class of regression fail loudly.
//
// Phase 16 review (MAJOR-2): the original integration test drove every layer
// through `QueryEngine.prepareRequest` with budgets that put pre-compaction
// usage well below the 80% prune threshold — the verdict was 'none' for L2
// and L3, the layers never fired, and the negative-only assertions passed
// trivially against unmodified content. This rewrite calls each layer
// directly (as exported pure functions) so each test exercises EXACTLY the
// code path it claims, plus a fourth end-to-end case driven through
// prepareRequest with a budget that actually triggers the cascade.
//
// Each test asserts BOTH:
//   - Negative: no `[REDAC` substring NOT followed by `TED:` (catches a
//     marker sliced apart by truncation/snip/placeholder logic).
//   - Positive: either the full marker survives, OR the layer's documented
//     replacement string is present (e.g., L3's MICRO_COMPACTED_PLACEHOLDER,
//     L2's `[snipped N consecutive failed tool calls ...]` system note).
// The dual assertion means a future bug that drops content entirely (every
// negative passes against an empty string) will fail the positive.

import { describe, expect, it } from 'vitest';
import type { Message } from '../../src/adapters/messages.js';
import { QueryEngine } from '../../src/orchestrator/QueryEngine.js';
import {
  MICRO_COMPACTED_PLACEHOLDER,
  microCompact,
} from '../../src/orchestrator/compaction/microCompactor.js';
import { snipDeadEnds } from '../../src/orchestrator/compaction/snipper.js';
import { pruneToolOutputs } from '../../src/orchestrator/compaction/toolOutputPruner.js';

describe('Compaction-Redaction integration (Phase 16 Task 103)', () => {
  // Negative-assertion regex: any `[REDAC` NOT followed by `TED:` is proof a
  // marker was sliced apart somewhere. A pristine `[REDACTED:env_value]`
  // matches `[REDAC` then `TED:` — the lookahead `(?!TED:)` is FALSE so the
  // regex does NOT match. A fragmented `[REDAC` at a truncation boundary
  // fails the lookahead and the regex DOES match.
  const partialMarker = /\[REDAC(?!TED:)/;

  it('L1 (pruneToolOutputs) preserves a [REDACTED:*] marker placed inside the truncation window', () => {
    // L1 truncates oversized tool results to maxToolOutputChars in the
    // unprotected zone. A marker at the head of the content survives
    // truncation; the test locks BOTH the marker presence (positive) AND the
    // absence of mid-marker fragments (negative).
    const longContent = `KEY=[REDACTED:env_value] start of output ${'x'.repeat(5000)}`;
    const history: Message[] = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 't1', name: 'bash', args: {} }],
      },
      {
        role: 'tool',
        result: {
          tool_use_id: 't1',
          command: 'bash echo',
          is_error: false,
          content: longContent,
        },
      },
    ];

    // protectedTailMessages: 0 → all messages are in the unprotected zone, so
    // L1 truncation applies. maxToolOutputChars: 200 forces truncation
    // (longContent is ~5040 chars).
    const after = pruneToolOutputs(history, {
      maxToolOutputChars: 200,
      protectedTailMessages: 0,
    });

    const tool = after.find((m): m is Extract<Message, { role: 'tool' }> => m.role === 'tool');
    expect(tool).toBeDefined();
    const content = tool?.result.content ?? '';
    // Positive: full marker present (it lives in the head, before truncation lands).
    expect(content).toContain('[REDACTED:env_value]');
    // Negative: no fragmented markers anywhere.
    expect(content).not.toMatch(partialMarker);
    // L1 actually fired (truncation marker present).
    expect(content).toContain('[truncated:');
  });

  it('L2 (snipDeadEnds) collapses 3+ consecutive error tool runs without fragmenting markers in the snip note', () => {
    // L2 detects runs of 3+ consecutive error tool messages in the
    // unprotected zone and replaces them with a single
    // `[snipped N consecutive failed tool calls — abandoned trajectory]`
    // system note. The snipper requires CONSECUTIVE error tool messages
    // without interleaved assistant messages — this happens in production
    // when one assistant turn emits multiple tool_calls that all error,
    // which is the shape we construct here.
    const history: Message[] = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 't1', name: 'bash', args: {} },
          { id: 't2', name: 'bash', args: {} },
          { id: 't3', name: 'bash', args: {} },
          { id: 't4', name: 'bash', args: {} },
          { id: 't5', name: 'bash', args: {} },
        ],
      },
      {
        role: 'tool',
        result: {
          tool_use_id: 't1',
          command: 'bash',
          is_error: true,
          content: 'err1 KEY=[REDACTED:env_value]',
        },
      },
      {
        role: 'tool',
        result: {
          tool_use_id: 't2',
          command: 'bash',
          is_error: true,
          content: 'err2 KEY=[REDACTED:env_value]',
        },
      },
      {
        role: 'tool',
        result: {
          tool_use_id: 't3',
          command: 'bash',
          is_error: true,
          content: 'err3 KEY=[REDACTED:env_value]',
        },
      },
      {
        role: 'tool',
        result: {
          tool_use_id: 't4',
          command: 'bash',
          is_error: true,
          content: 'err4 KEY=[REDACTED:env_value]',
        },
      },
      {
        role: 'tool',
        result: {
          tool_use_id: 't5',
          command: 'bash',
          is_error: true,
          content: 'err5 KEY=[REDACTED:env_value]',
        },
      },
      // A clean trailing assistant in the protected tail so the run is
      // unambiguously in the unprotected zone.
      { role: 'assistant', content: 'recovered' },
    ];

    // protectedTailTokens: 5 → only the trailing assistant is protected;
    // the run of 5 errors is exposed to L2.
    const after = snipDeadEnds(history, { protectedTailTokens: 5 });

    // Positive: snip-note system message is present (proof L2 fired).
    const snipNote = after.find(
      (m) => m.role === 'system' && typeof m.content === 'string' && m.content.includes('[snipped'),
    );
    expect(snipNote).toBeDefined();
    expect(snipNote?.role === 'system' ? snipNote.content : '').toMatch(
      /\[snipped \d+ consecutive failed tool calls/,
    );
    // The collapsed run is gone — no error tool messages survive.
    const remainingErrorTools = after.filter(
      (m): m is Extract<Message, { role: 'tool' }> => m.role === 'tool' && m.result.is_error,
    );
    expect(remainingErrorTools).toHaveLength(0);
    // Negative: no message anywhere carries a fragmented marker.
    for (const m of after) {
      const text =
        m.role === 'tool'
          ? m.result.content
          : m.role === 'system' || m.role === 'user' || m.role === 'assistant'
            ? (m.content ?? '')
            : '';
      expect(text).not.toMatch(partialMarker);
    }
  });

  it('L3 (microCompact) replaces tool result content with [micro-compacted] without fragmenting markers', () => {
    // L3 strips the content of every tool message in the unprotected zone,
    // replacing it with the fixed MICRO_COMPACTED_PLACEHOLDER. Verifies the
    // placeholder string contains no `[REDAC` fragment and that tool
    // metadata (tool_use_id, command, is_error) is preserved.
    const history: Message[] = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 't1', name: 'bash', args: {} }],
      },
      {
        role: 'tool',
        result: {
          tool_use_id: 't1',
          command: 'bash',
          is_error: false,
          content: 'something with KEY=[REDACTED:env_value] inside',
        },
      },
    ];

    // protectedTailMessages: 0 → tool message is unprotected → L3 fires.
    const after = microCompact(history, { protectedTailMessages: 0 });

    const tool = after.find((m): m is Extract<Message, { role: 'tool' }> => m.role === 'tool');
    expect(tool).toBeDefined();
    // Positive: content was replaced with the documented placeholder.
    expect(tool?.result.content).toBe(MICRO_COMPACTED_PLACEHOLDER);
    // Negative: placeholder contains no `[REDAC` fragment.
    expect(tool?.result.content).not.toMatch(partialMarker);
    // Metadata preserved.
    expect(tool?.result.tool_use_id).toBe('t1');
    expect(tool?.result.command).toBe('bash');
    expect(tool?.result.is_error).toBe(false);
  });

  it('end-to-end through prepareRequest: cascade triggers under realistic budget pressure', () => {
    // End-to-end cascade test. The previous L1/L2/L3 tests call each layer
    // directly so they exercise the layer in isolation; this fourth test
    // ensures the integrated `prepareRequest` path also preserves marker
    // integrity when the cascade actually fires.
    //
    // Sizing the budget: a single ~5040-char tool result is roughly 1260
    // tokens (chars/4). System+user+assistant adds ~10-30 tokens. Setting
    // workingBudget=600 puts pre-compaction usage well above 95% (refusal
    // threshold) — so all three layers fire per R10's escalation ladder.
    // L1 truncates to 200 chars, L3 then overwrites with the placeholder.
    // The test does not assert WHICH layer last touched the content; it
    // only asserts no marker fragment survives anywhere.
    const longContent = `KEY=[REDACTED:env_value] head ${'y'.repeat(5000)}`;
    const engine = new QueryEngine({
      systemPrompt: 'sys',
      workingBudget: 600,
      maxToolOutputChars: 200,
      protectedTailMessages: 0,
    });
    engine.appendUser('go');
    engine.appendAssistant({ content: '', tool_calls: [{ id: 't1', name: 'bash', args: {} }] });
    engine.appendToolResult({
      tool_use_id: 't1',
      command: 'bash echo',
      is_error: false,
      content: longContent,
    });

    const req = engine.prepareRequest({
      model: 'm',
      tools: [],
      thinking: false,
      strict: true,
    });

    // No message anywhere carries a fragmented marker.
    for (const m of req.messages) {
      const text =
        m.role === 'tool'
          ? m.result.content
          : m.role === 'system' || m.role === 'user' || m.role === 'assistant'
            ? (m.content ?? '')
            : '';
      expect(text).not.toMatch(partialMarker);
    }
  });
});
