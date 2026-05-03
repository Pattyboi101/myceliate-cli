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
});
