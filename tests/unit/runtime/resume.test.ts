// tests/unit/runtime/resume.test.ts
import { describe, expect, it } from 'vitest';
import type { Message } from '../../../src/adapters/messages.js';
import { isSafeToResume } from '../../../src/runtime/resume.js';

describe('isSafeToResume (Phase 18 Task 110)', () => {
  it('returns true for an empty history (fresh resume)', () => {
    expect(isSafeToResume([])).toBe(true);
  });

  it('returns true when the last message is a clean assistant terminal turn', () => {
    const h: Message[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];
    expect(isSafeToResume(h)).toBe(true);
  });

  it('returns true when the last assistant turn had tool_calls AND every call has a tool result', () => {
    const h: Message[] = [
      { role: 'user', content: 'do' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 't1', name: 'bash', args: {} },
          { id: 't2', name: 'bash', args: {} },
        ],
      },
      {
        role: 'tool',
        result: { tool_use_id: 't1', command: 'bash', is_error: false, content: 'ok1' },
      },
      {
        role: 'tool',
        result: { tool_use_id: 't2', command: 'bash', is_error: false, content: 'ok2' },
      },
      { role: 'assistant', content: 'done' },
    ];
    expect(isSafeToResume(h)).toBe(true);
  });

  it('returns false when the last assistant turn has tool_calls without matching results', () => {
    const h: Message[] = [
      { role: 'user', content: 'do' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 't1', name: 'bash', args: {} }],
      },
      // No tool result for t1 — interrupted mid-flow.
    ];
    expect(isSafeToResume(h)).toBe(false);
  });

  it('returns false when only some tool_calls have matching results', () => {
    const h: Message[] = [
      { role: 'user', content: 'do' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 't1', name: 'bash', args: {} },
          { id: 't2', name: 'bash', args: {} },
        ],
      },
      {
        role: 'tool',
        result: { tool_use_id: 't1', command: 'bash', is_error: false, content: 'ok' },
      },
      // t2 has no result.
    ];
    expect(isSafeToResume(h)).toBe(false);
  });
});
