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
    // 5-line collapsed view default — line 5 onwards is hidden.
    expect(frame).not.toContain('line 49');
    expect(frame).toContain('… 45 more lines');
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
});
