import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { TelemetryFooter } from '../../../src/ui/TelemetryFooter.js';

describe('TelemetryFooter', () => {
  it('renders last-turn tokens and cost in gray on the left', () => {
    const { lastFrame } = render(
      <TelemetryFooter
        lastTurnInputTokens={1234}
        lastTurnOutputTokens={5670}
        lastTurnCostUSD={0.0023}
        sessionTotalCostUSD={0.018}
      />,
    );
    expect(lastFrame()).toContain('last turn');
    expect(lastFrame()).toContain('1.2k');
    expect(lastFrame()).toContain('5.7k');
    expect(lastFrame()).toContain('$0.0023');
  });

  it('renders session total in green on the right', () => {
    const { lastFrame } = render(
      <TelemetryFooter
        lastTurnInputTokens={0}
        lastTurnOutputTokens={0}
        lastTurnCostUSD={0}
        sessionTotalCostUSD={0.42}
      />,
    );
    expect(lastFrame()).toContain('session total');
    expect(lastFrame()).toContain('$0.42');
  });

  it('shows subagent progress line when subagent prop provided', () => {
    const { lastFrame } = render(
      <TelemetryFooter
        lastTurnInputTokens={0}
        lastTurnOutputTokens={0}
        lastTurnCostUSD={0}
        sessionTotalCostUSD={0}
        subagent={{ step: 2, durationMs: 1500 }}
      />,
    );
    expect(lastFrame()).toContain('subagent');
    expect(lastFrame()).toContain('step 2');
    expect(lastFrame()).toContain('1.5s');
  });

  it('omits subagent line when subagent prop is undefined', () => {
    const { lastFrame } = render(
      <TelemetryFooter
        lastTurnInputTokens={0}
        lastTurnOutputTokens={0}
        lastTurnCostUSD={0}
        sessionTotalCostUSD={0}
      />,
    );
    expect(lastFrame()).not.toContain('subagent');
  });

  it('formats tokens under 1000 without k suffix', () => {
    const { lastFrame } = render(
      <TelemetryFooter
        lastTurnInputTokens={500}
        lastTurnOutputTokens={42}
        lastTurnCostUSD={0.0001}
        sessionTotalCostUSD={0.0001}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('500');
    expect(frame).toContain('42');
    expect(frame).not.toContain('0.5k');
  });

  it('formats subagent duration under 1000ms with ms suffix', () => {
    const { lastFrame } = render(
      <TelemetryFooter
        lastTurnInputTokens={0}
        lastTurnOutputTokens={0}
        lastTurnCostUSD={0}
        sessionTotalCostUSD={0}
        subagent={{ step: 0, durationMs: 250 }}
      />,
    );
    expect(lastFrame()).toContain('250ms');
  });

  it('uses no emoji', () => {
    const { lastFrame } = render(
      <TelemetryFooter
        lastTurnInputTokens={1000}
        lastTurnOutputTokens={500}
        lastTurnCostUSD={0.001}
        sessionTotalCostUSD={0.01}
        subagent={{ step: 0, durationMs: 100 }}
      />,
    );
    const frame = lastFrame() ?? '';
    // ASCII only — no codepoints in emoji blocks.
    expect(frame.match(/[\u{1F300}-\u{1FAFF}]/u)).toBeNull();
    expect(frame.match(/[\u{2600}-\u{27BF}]/u)).toBeNull();
  });
});
