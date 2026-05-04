// tests/unit/ui/ToolCallCard.test.tsx
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { ToolCallCard, type ToolCallCardState } from '../../../src/ui/ToolCallCard.js';

describe('ToolCallCard', () => {
  it('renders tool name + args summary while running with a spinner-glyph', () => {
    const card: ToolCallCardState = {
      id: 't1',
      name: 'bash',
      args: { command: 'ls -la' },
      status: 'running',
    };
    const { lastFrame } = render(<ToolCallCard card={card} />);
    expect(lastFrame()).toContain('bash');
    expect(lastFrame()).toContain('ls -la');
  });

  it('renders duration + preview when status is completed', () => {
    const card: ToolCallCardState = {
      id: 't1',
      name: 'bash',
      args: { command: 'ls' },
      status: 'completed',
      durationMs: 42,
      preview: 'foo.ts\nbar.ts',
    };
    const { lastFrame } = render(<ToolCallCard card={card} />);
    expect(lastFrame()).toContain('42ms');
    expect(lastFrame()).toContain('foo.ts');
  });

  it('renders error message when status is failed', () => {
    const card: ToolCallCardState = {
      id: 't1',
      name: 'bash',
      args: { command: 'doesntexist' },
      status: 'failed',
      durationMs: 12,
      error: 'spawn ENOENT',
    };
    const { lastFrame } = render(<ToolCallCard card={card} />);
    expect(lastFrame()).toContain('spawn ENOENT');
  });

  // Phase 14 Task 92 will wire the orchestrator-side emission of `status: 'rejected'`
  // through the HITL gate's bash-veto path. The card-rendering contract is locked here
  // so the Phase 14 implementer needs only to emit the event, not change the UI.
  it('renders rejection feedback when status is rejected', () => {
    const card: ToolCallCardState = {
      id: 't1',
      name: 'bash',
      args: { command: 'rm -rf /' },
      status: 'rejected',
      durationMs: 0,
      error: 'rejected by user',
    };
    const { lastFrame } = render(<ToolCallCard card={card} />);
    expect(lastFrame()).toContain('rejected');
  });

  it('renders only the first N lines of a long preview when collapsed', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
    const card: ToolCallCardState = {
      id: 't1',
      name: 'bash',
      args: { command: 'seq 50' },
      status: 'completed',
      durationMs: 10,
      preview: lines,
    };
    const { lastFrame } = render(<ToolCallCard card={card} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('line 0');
    expect(frame).toContain('line 4');
    // 5-line collapsed view default — line 5 onwards is hidden. Phase 15
    // review n1: assert the exact boundary (`line 5` absent) so a regression
    // increasing COLLAPSED_LINES to 6 fails loudly. `'line 4'` would otherwise
    // also substring-match `'line 40'`–`'line 49'`.
    expect(frame).not.toContain('line 5');
    expect(frame).not.toContain('line 49');
    expect(frame).toContain('… 45 more lines');
  });

  // Phase 15 review coverage gap #2: lock the slice boundary at exactly N.
  // An off-by-one in either visibleLines.slice or hiddenCount math would
  // produce a spurious "… 0 more lines" footer; this test guards against it.
  it('renders all lines without footer when preview has exactly COLLAPSED_LINES lines', () => {
    const lines = Array.from({ length: 5 }, (_, i) => `line ${i}`).join('\n');
    const card: ToolCallCardState = {
      id: 't1',
      name: 'bash',
      args: { command: 'seq 5' },
      status: 'completed',
      durationMs: 5,
      preview: lines,
    };
    const { lastFrame } = render(<ToolCallCard card={card} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('line 0');
    expect(frame).toContain('line 4');
    expect(frame).not.toMatch(/more lines/);
  });

  it('renders the full preview when expanded prop is true', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n');
    const card: ToolCallCardState = {
      id: 't1',
      name: 'bash',
      args: { command: 'seq 10' },
      status: 'completed',
      durationMs: 10,
      preview: lines,
    };
    const { lastFrame } = render(<ToolCallCard card={card} expanded />);
    expect(lastFrame()).toContain('line 9');
  });

  it('highlights [REDACTED:*] markers in the preview body with magenta', () => {
    const card: ToolCallCardState = {
      id: 't1',
      name: 'bash',
      args: { command: 'env' },
      status: 'completed',
      durationMs: 5,
      preview: 'OPENAI_API_KEY=[REDACTED:env_value]\nOTHER=plain',
    };
    const { lastFrame } = render(<ToolCallCard card={card} />);
    const frame = lastFrame() ?? '';
    // Text-presence + structural-preservation assertion. The actual magenta
    // color cannot be asserted here — `ink-testing-library`'s `lastFrame()`
    // strips ANSI escapes when running in a non-TTY (chalk's `supportsColor`
    // detection returns false under vitest). Color is verified by the v1.1
    // manual smoke (docs/MANUAL_SMOKE.md → Redaction visibility section).
    // v1.2 could force-enable chalk via `FORCE_COLOR=3` in the test setup
    // and assert `/\x1b\[35m[^\x1b]*\[REDACTED:env_value\]/`.
    expect(frame).toContain('[REDACTED:env_value]');
    expect(frame).toContain('OTHER=plain');
  });
});
