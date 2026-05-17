import { render } from 'ink-testing-library';
import React from 'react';
// tests/unit/ui/App.test.tsx
import { describe, expect, it } from 'vitest';
import { App, type AppState } from '../../../src/ui/App.js';
import type { ToolCallCardState } from '../../../src/ui/ToolCallCard.js';

/** Minimal AppState for tests that only care about a specific behaviour. */
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
  lastTurnCost: 0,
  sessionTotalCost: 0,
};

it('renders <InputBox> when phase is awaiting_input', () => {
  const state: AppState = { ...baseState };
  const { lastFrame } = render(<App state={state} />);
  // InputBox renders the gray block-cursor glyph as its visible marker.
  expect(lastFrame()).toContain('▎');
});

it('hides <InputBox> while streaming', () => {
  const state: AppState = {
    ...baseState,
    userInput: 'hi',
    content: 'partial answer',
    phase: 'streaming',
  };
  const { lastFrame } = render(<App state={state} />);
  expect(lastFrame()).not.toContain('▎');
});

describe('App', () => {
  it('renders the reasoning block above the content stream', () => {
    const state: AppState = {
      ...baseState,
      userInput: 'do thing',
      reasoning: { text: 'thinking', phase: 'streaming', startedAtMs: Date.now() },
      content: 'partial answer',
      phase: 'streaming',
    };
    const { lastFrame } = render(<App state={state} />);
    const f = lastFrame() ?? '';
    expect(f).toContain('thinking');
    expect(f).toContain('partial answer');
  });

  it('shows the approval prompt overlay when approvalRequests has an entry', () => {
    const state: AppState = {
      ...baseState,
      userInput: 'do thing',
      approvalRequests: [
        { kind: 'bash', requestId: 'r1', command: 'rm -rf x', cwd: '/x', reason: 'why' },
      ],
      phase: 'streaming',
    };
    const { lastFrame } = render(<App state={state} />);
    expect(lastFrame()).toContain('Approval required');
  });

  it('toggles reasoning expansion when Tab is pressed', async () => {
    const state: AppState = {
      ...baseState,
      userInput: 'do thing',
      reasoning: {
        text: 'long internal monologue spanning many words',
        phase: 'complete',
        startedAtMs: Date.now() - 3400,
      },
      phase: 'streaming',
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
      ...baseState,
      userInput: 'do thing',
      reasoning: { text: 'thinking', phase: 'complete', startedAtMs, endedAtMs },
      phase: 'streaming',
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
      ...baseState,
      userInput: 'go',
      approvalRequests: [
        { kind: 'bash', requestId: 'r1', command: 'rm -rf /tmp/a', cwd: '/', reason: 'rm-rf' },
        { kind: 'bash', requestId: 'r2', command: 'rm -rf /tmp/b', cwd: '/', reason: 'rm-rf' },
      ],
      phase: 'streaming',
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
    ...baseState,
    userInput: 'go',
    phase: 'streaming',
    toolCalls: [toolCall],
  };
  const { lastFrame } = render(<App state={state} />);
  expect(lastFrame()).toContain('bash');
  expect(lastFrame()).toContain('25ms');
  expect(lastFrame()).toContain('foo.ts');
});

describe('GerminationCard mid-stream collapse', () => {
  // Phase 24 Task 1: closes spec §7.2 deviation flagged in v1.3 Phase 21
  // plan-pointer note. Card collapses to a one-line summary on the first
  // content_delta event (i.e. once `state.content.length > 0`), instead of
  // persisting the full bordered banner until `turn_complete`. Also closes
  // test gap A from Phase 21 (App.tsx GerminationCard render-path coverage).
  const banner = { model: 'deepseek-chat', adapter: 'v3' as const, cwd: '/tmp' };

  it('renders the full bordered card while no content has streamed', () => {
    const state: AppState = {
      ...baseState,
      userInput: 'go',
      phase: 'streaming',
      activeSpore: { name: 'research', accent_color: '#4a90c4' },
      germinationCard: { name: 'research', accent_color: '#4a90c4' },
    };
    const { lastFrame } = render(<App state={state} banner={banner} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('research');
    expect(frame).toMatch(/Germinating/i);
    // Pre-stream: full bordered banner is present.
    expect(frame).toMatch(/[╭─╮│╰╯┌─┐└┘]/);
  });

  it('collapses to one-line summary once content streaming begins', () => {
    const state: AppState = {
      ...baseState,
      userInput: 'go',
      content: 'The first chunk of model response...',
      phase: 'streaming',
      activeSpore: { name: 'research', accent_color: '#4a90c4' },
      germinationCard: { name: 'research', accent_color: '#4a90c4' },
    };
    const { lastFrame } = render(<App state={state} banner={banner} />);
    const frame = lastFrame() ?? '';
    // Collapsed marker (▸) plus the spore name.
    expect(frame).toContain('research');
    expect(frame).toContain('▸');
    // Streamed content is still visible.
    expect(frame).toContain('The first chunk');
    // Crucially: no bordered banner around the germination message.
    // We isolate the GerminationCard region by checking it does NOT contain
    // the "Germinating" message inside a single-border banner. A Box border
    // surrounds the message with horizontal rule chars on the surrounding
    // lines; the collapsed form has no such surrounding border for the card.
    // Heuristic: the frame contains at most one bordered region (the
    // InputBox is hidden during streaming, banner has no border, turns log
    // has no border). After collapse there should be NO single-line border.
    expect(frame).not.toMatch(/┌─+┐/);
    expect(frame).not.toMatch(/└─+┘/);
  });

  it('hides the germination card entirely when germinationCard is null', () => {
    const state: AppState = {
      ...baseState,
      userInput: 'go',
      content: 'partial',
      phase: 'streaming',
      germinationCard: null,
    };
    const { lastFrame } = render(<App state={state} banner={banner} />);
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('▸ research');
    expect(frame).not.toMatch(/Germinating/);
  });
});

it('expands the most recent ToolCallCard when Tab is pressed (after reasoning toggle precedence)', async () => {
  const state: AppState = {
    ...baseState,
    userInput: 'go',
    phase: 'streaming',
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

describe('T40: App layout refactor — static banner + telemetry footer', () => {
  it('renders the session banner with id and caveman OFF when sessionId and inactive cavemanState are provided', () => {
    const state: AppState = { ...baseState };
    const cavemanState = { active: false };
    const { lastFrame } = render(
      <App
        state={state}
        sessionId="abcdef12-3456-7890-abcd-ef1234567890"
        cavemanState={cavemanState}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('myceliate-cli');
    expect(frame).toContain('abcdef12'); // first 8 chars of session id
    expect(frame).toContain('caveman OFF');
  });

  it('renders caveman ON indicator in session banner when cavemanState.active is true', () => {
    const state: AppState = { ...baseState };
    const cavemanState = { active: true };
    const { lastFrame } = render(
      <App
        state={state}
        sessionId="aaaabbbb-cccc-dddd-eeee-ffff00001111"
        cavemanState={cavemanState}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('caveman ON');
  });

  it('omits the session banner when sessionId is not provided', () => {
    const state: AppState = { ...baseState };
    const { lastFrame } = render(<App state={state} />);
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('myceliate-cli | session');
  });

  it('renders TelemetryFooter with zero-state values when no cost has arrived', () => {
    const state: AppState = { ...baseState };
    const { lastFrame } = render(<App state={state} />);
    const frame = lastFrame() ?? '';
    // TelemetryFooter shows "last turn:" even with zeros.
    expect(frame).toContain('last turn:');
    expect(frame).toContain('session total:');
  });

  it('renders TelemetryFooter with lastTurnCost and sessionTotalCost when populated', () => {
    const state: AppState = {
      ...baseState,
      lastTurnUsage: { inputTokens: 1200, outputTokens: 300 },
      lastTurnCost: 0.0014,
      sessionTotalCost: 0.0028,
    };
    const { lastFrame } = render(<App state={state} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('1.2k in');
    expect(frame).toContain('300 out');
    expect(frame).toContain('$0.0014');
    expect(frame).toContain('$0.00'); // session total at 2dp
  });

  it('renders TelemetryFooter before InputBox in the footer region', () => {
    const state: AppState = { ...baseState };
    const { lastFrame } = render(<App state={state} />);
    const frame = lastFrame() ?? '';
    const telemetryIdx = frame.indexOf('last turn:');
    const inputIdx = frame.indexOf('▎');
    // TelemetryFooter text appears before the InputBox cursor glyph.
    expect(telemetryIdx).toBeGreaterThanOrEqual(0);
    expect(inputIdx).toBeGreaterThan(telemetryIdx);
  });

  it('renders subagent indicator in TelemetryFooter when subagentStatus is set', () => {
    const state: AppState = {
      ...baseState,
      phase: 'streaming',
      subagentStatus: { step: 2, durationMs: 1500 },
    };
    const { lastFrame } = render(<App state={state} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('subagent: step 2');
    expect(frame).toContain('1.5s');
  });

  it('does not render subagent indicator when subagentStatus is absent', () => {
    const state: AppState = { ...baseState, phase: 'streaming' };
    const { lastFrame } = render(<App state={state} />);
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('subagent: step');
  });
});
