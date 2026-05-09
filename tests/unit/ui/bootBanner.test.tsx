import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { App } from '../../../src/ui/App.js';
import type { AppState } from '../../../src/ui/App.js';

const baseState: AppState = {
  userInput: '',
  reasoning: null,
  content: '',
  approvalRequests: [],
  phase: 'awaiting_input',
  turns: [],
  toolCalls: [],
  activeSpore: null,
  bootWarnings: [],
};

describe('App boot warnings banner', () => {
  it('banner is hidden when bootWarnings is empty', () => {
    const { lastFrame } = render(
      React.createElement(App, { state: { ...baseState, bootWarnings: [] } }),
    );
    const out = lastFrame() ?? '';
    expect(out).not.toContain('[!]');
  });

  it('banner renders when bootWarnings is non-empty', () => {
    const { lastFrame } = render(
      React.createElement(App, {
        state: { ...baseState, bootWarnings: ['Pinned spore "old-pack" not found'] },
      }),
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('[!]');
  });

  it('each warning renders on its own line prefixed with [!]', () => {
    const warnings = ['Warning one from spore', 'Warning two from other spore'];
    const { lastFrame } = render(
      React.createElement(App, { state: { ...baseState, bootWarnings: warnings } }),
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('[!] Warning one from spore');
    expect(out).toContain('[!] Warning two from other spore');
  });
});
