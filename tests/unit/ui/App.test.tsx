import { render } from 'ink-testing-library';
import React from 'react';
// tests/unit/ui/App.test.tsx
import { describe, expect, it } from 'vitest';
import { App, type AppState } from '../../../src/ui/App.js';

describe('App', () => {
  it('renders the reasoning block above the content stream', () => {
    const state: AppState = {
      userInput: 'do thing',
      reasoning: { text: 'thinking', phase: 'streaming', startedAtMs: Date.now() },
      content: 'partial answer',
      approvalRequest: null,
    };
    const { lastFrame } = render(<App state={state} />);
    const f = lastFrame() ?? '';
    expect(f).toContain('thinking');
    expect(f).toContain('partial answer');
  });

  it('shows the approval prompt overlay when approvalRequest is present', () => {
    const state: AppState = {
      userInput: 'do thing',
      reasoning: null,
      content: '',
      approvalRequest: { command: 'rm -rf x', cwd: '/x', reason: 'why' },
    };
    const { lastFrame } = render(<App state={state} />);
    expect(lastFrame()).toContain('Approval required');
  });
});
