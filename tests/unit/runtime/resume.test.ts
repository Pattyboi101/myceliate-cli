// tests/unit/runtime/resume.test.ts
import { describe, expect, it } from 'vitest';
import type { Message } from '../../../src/adapters/messages.js';
import {
  buildTurnsFromHistory,
  isSafeToResume,
  parseResumeFlag,
} from '../../../src/runtime/resume.js';

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

// Phase 18 review m2: buildTurnsFromHistory had zero unit tests previously.
// These lock the pairing logic against future regressions.
describe('buildTurnsFromHistory (Phase 18 review m2)', () => {
  it('returns empty array for empty history', () => {
    expect(buildTurnsFromHistory([])).toEqual([]);
  });

  it('pairs a single user → terminal-assistant exchange into one turn', () => {
    const h: Message[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ];
    expect(buildTurnsFromHistory(h)).toEqual([{ userInput: 'hello', content: 'hi there' }]);
  });

  it('skips assistant tool-call messages and tool result messages, pairing user with the eventual terminal assistant', () => {
    // Multi-step ReAct: user asks → assistant calls bash → tool result → terminal assistant.
    // Only the (user, terminal-assistant) pair becomes a CompletedTurn.
    const h: Message[] = [
      { role: 'user', content: 'list the files' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 't1', name: 'bash', args: {} }],
      },
      {
        role: 'tool',
        result: { tool_use_id: 't1', command: 'bash', is_error: false, content: 'README.md' },
      },
      { role: 'assistant', content: 'There is 1 file: README.md' },
    ];
    expect(buildTurnsFromHistory(h)).toEqual([
      { userInput: 'list the files', content: 'There is 1 file: README.md' },
    ]);
  });

  it('builds multiple turns across a multi-turn conversation', () => {
    const h: Message[] = [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'a2' },
    ];
    expect(buildTurnsFromHistory(h)).toEqual([
      { userInput: 'q1', content: 'a1' },
      { userInput: 'q2', content: 'a2' },
    ]);
  });

  it('drops an orphaned trailing user message (no terminal assistant follows)', () => {
    // History ends mid-flight: user submitted but assistant hasn't completed.
    // The pending user input is NOT a completed turn.
    const h: Message[] = [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2 pending' },
    ];
    expect(buildTurnsFromHistory(h)).toEqual([{ userInput: 'q1', content: 'a1' }]);
  });

  it('treats null assistant content as empty string in the rendered turn', () => {
    const h: Message[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: null },
    ];
    expect(buildTurnsFromHistory(h)).toEqual([{ userInput: 'go', content: '' }]);
  });
});

// Phase 18 review m3: parseResumeFlag had zero unit tests previously.
// Locks the throw cases that the implementation guards against.
describe('parseResumeFlag (Phase 18 review m3)', () => {
  it('returns undefined when --resume is absent', () => {
    expect(parseResumeFlag(['--other', 'value'])).toBeUndefined();
    expect(parseResumeFlag([])).toBeUndefined();
  });

  it('returns the id when --resume is followed by a non-flag value', () => {
    expect(parseResumeFlag(['--resume', 'abc-123'])).toBe('abc-123');
    expect(parseResumeFlag(['--first', 'x', '--resume', 'sess-1'])).toBe('sess-1');
  });

  it('throws when --resume is at end-of-argv (missing argument)', () => {
    expect(() => parseResumeFlag(['--resume'])).toThrow(/--resume requires a session-id/);
  });

  it('throws when --resume is followed by another flag', () => {
    expect(() => parseResumeFlag(['--resume', '--other-flag'])).toThrow(
      /--resume requires a session-id/,
    );
  });

  it('throws when --resume is followed by an empty string', () => {
    expect(() => parseResumeFlag(['--resume', ''])).toThrow(/--resume requires a session-id/);
  });

  it('uses the FIRST occurrence when --resume appears multiple times', () => {
    expect(parseResumeFlag(['--resume', 'first', '--resume', 'second'])).toBe('first');
  });
});
