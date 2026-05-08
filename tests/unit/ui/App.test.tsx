import { render } from 'ink-testing-library';
import React from 'react';
// tests/unit/ui/App.test.tsx
import { describe, expect, it } from 'vitest';
import { App, type AppState } from '../../../src/ui/App.js';
import type { ToolCallCardState } from '../../../src/ui/ToolCallCard.js';

it('renders <PromptInput> when phase is awaiting_input', () => {
  const state: AppState = {
    userInput: '',
    reasoning: null,
    content: '',
    approvalRequests: [],
    phase: 'awaiting_input',
    turns: [],
    toolCalls: [],
    activeSpore: null,
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
    approvalRequests: [],
    phase: 'streaming',
    turns: [],
    toolCalls: [],
    activeSpore: null,
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
      approvalRequests: [],
      phase: 'streaming',
      turns: [],
      toolCalls: [],
      activeSpore: null,
    };
    const { lastFrame } = render(<App state={state} />);
    const f = lastFrame() ?? '';
    expect(f).toContain('thinking');
    expect(f).toContain('partial answer');
  });

  it('shows the approval prompt overlay when approvalRequests has an entry', () => {
    const state: AppState = {
      userInput: 'do thing',
      reasoning: null,
      content: '',
      approvalRequests: [{ requestId: 'r1', command: 'rm -rf x', cwd: '/x', reason: 'why' }],
      phase: 'streaming',
      turns: [],
      toolCalls: [],
      activeSpore: null,
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
      approvalRequests: [],
      phase: 'streaming',
      turns: [],
      toolCalls: [],
      activeSpore: null,
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
      approvalRequests: [],
      phase: 'streaming',
      turns: [],
      toolCalls: [],
      activeSpore: null,
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

  it('renders the head of state.approvalRequests as <ApprovalPrompt> and ignores tail entries', () => {
    const state: AppState = {
      userInput: 'go',
      reasoning: null,
      content: '',
      approvalRequests: [
        { requestId: 'r1', command: 'rm -rf /tmp/a', cwd: '/', reason: 'rm-rf' },
        { requestId: 'r2', command: 'rm -rf /tmp/b', cwd: '/', reason: 'rm-rf' },
      ],
      phase: 'streaming',
      turns: [],
      toolCalls: [],
      activeSpore: null,
    };
    const { lastFrame } = render(<App state={state} />);
    const frame = lastFrame() ?? '';
    // Head is rendered.
    expect(frame).toContain('rm -rf /tmp/a');
    // Tail is NOT rendered (single-prompt-at-a-time UI).
    expect(frame).not.toContain('rm -rf /tmp/b');
  });
});

it('renders ToolCallCard for each entry in state.toolCalls', () => {
  const toolCall: ToolCallCardState = {
    id: 't1',
    name: 'bash',
    args: { command: 'ls' },
    status: 'completed',
    durationMs: 25,
    preview: 'foo.ts',
  };
  const state: AppState = {
    userInput: 'go',
    reasoning: null,
    content: '',
    approvalRequests: [],
    phase: 'streaming',
    turns: [],
    toolCalls: [toolCall],
    activeSpore: null,
  };
  const { lastFrame } = render(<App state={state} />);
  expect(lastFrame()).toContain('bash');
  expect(lastFrame()).toContain('25ms');
  expect(lastFrame()).toContain('foo.ts');
});

it('expands the most recent ToolCallCard when Tab is pressed (after reasoning toggle precedence)', async () => {
  const state: AppState = {
    userInput: 'go',
    reasoning: null,
    content: '',
    approvalRequests: [],
    phase: 'streaming',
    turns: [],
    toolCalls: [
      {
        id: 't1',
        name: 'bash',
        args: { command: 'seq 50' },
        status: 'completed',
        durationMs: 10,
        preview: Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n'),
      },
    ],
    activeSpore: null,
  };
  const { stdin, lastFrame } = render(<App state={state} />);
  await new Promise((r) => setTimeout(r, 50));
  expect(lastFrame()).not.toContain('line 49'); // collapsed by default
  stdin.write('\t'); // Tab
  // 50ms matches Phase 10's keypress-timing rule (Ink's setRawMode/readable
  // listener registration); shorter waits are CI-flaky.
  await new Promise((r) => setTimeout(r, 50));
  // When state.reasoning is null, the Tab handler routes to setCardExpanded
  // and the latest card expands.
  expect(lastFrame()).toContain('line 49');
});
