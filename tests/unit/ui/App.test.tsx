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

  it('toggles reasoning expansion when Tab is pressed', async () => {
    const state: AppState = {
      userInput: 'do thing',
      reasoning: {
        text: 'long internal monologue spanning many words',
        phase: 'complete',
        startedAtMs: Date.now() - 3400,
      },
      content: '',
      approvalRequest: null,
    };
    const { lastFrame, stdin } = render(<App state={state} />);
    // Wait for Ink's useEffect to register the 'readable' listener via setRawMode.
    await new Promise((r) => setTimeout(r, 50));
    expect(lastFrame() ?? '').not.toContain('long internal monologue');
    expect(lastFrame() ?? '').toMatch(/Reasoning.*press Tab/);

    stdin.write('\t');
    await new Promise((r) => setTimeout(r, 50));
    expect(lastFrame() ?? '').toContain('long internal monologue');

    stdin.write('\t');
    await new Promise((r) => setTimeout(r, 50));
    expect(lastFrame() ?? '').not.toContain('long internal monologue');
  });
});
