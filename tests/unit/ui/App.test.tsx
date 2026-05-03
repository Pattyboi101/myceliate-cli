import { render } from 'ink-testing-library';
import React from 'react';
// tests/unit/ui/App.test.tsx
import { describe, expect, it } from 'vitest';
import { App, type AppState } from '../../../src/ui/App.js';

it('renders <PromptInput> when phase is awaiting_input', () => {
  const state: AppState = {
    userInput: '',
    reasoning: null,
    content: '',
    approvalRequest: null,
    phase: 'awaiting_input',
    turns: [],
  };
  const { lastFrame } = render(<App state={state} />);
  // PromptInput renders the gray block-cursor glyph as its visible marker.
  expect(lastFrame()).toContain('▎');
});

it('hides <PromptInput> while streaming', () => {
  const state: AppState = {
    userInput: 'hi',
    reasoning: null,
    content: 'partial answer',
    approvalRequest: null,
    phase: 'streaming',
    turns: [],
  };
  const { lastFrame } = render(<App state={state} />);
  expect(lastFrame()).not.toContain('▎');
});

describe('App', () => {
  it('renders the reasoning block above the content stream', () => {
    const state: AppState = {
      userInput: 'do thing',
      reasoning: { text: 'thinking', phase: 'streaming', startedAtMs: Date.now() },
      content: 'partial answer',
      approvalRequest: null,
      phase: 'streaming',
      turns: [],
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
      phase: 'streaming',
      turns: [],
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
      phase: 'streaming',
      turns: [],
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

  // F4: when endedAtMs is set, the rendered reasoning duration is frozen and
  // does not drift across re-renders. Without this fix, App's render-time
  // `Date.now() - startedAtMs` calculation kept ticking up while the answer
  // streamed (3 s reasoning displayed as 8 s by the time content finished).
  it('freezes reasoning duration when endedAtMs is set', async () => {
    const startedAtMs = Date.now() - 3400; // 3.4 s ago
    const endedAtMs = startedAtMs + 3400; // duration should display as 3.4 s
    const state: AppState = {
      userInput: 'do thing',
      reasoning: { text: 'thinking', phase: 'complete', startedAtMs, endedAtMs },
      content: '',
      approvalRequest: null,
      phase: 'streaming',
      turns: [],
    };
    const { lastFrame, rerender } = render(<App state={state} />);
    const f1 = lastFrame() ?? '';
    expect(f1).toMatch(/3\.4s/);
    // Wait long enough that a tick-up would be visible if the duration weren't frozen.
    await new Promise((r) => setTimeout(r, 600));
    rerender(<App state={state} />);
    const f2 = lastFrame() ?? '';
    // Same duration on re-render — frozen, not drifting.
    expect(f2).toMatch(/3\.4s/);
  });
});
