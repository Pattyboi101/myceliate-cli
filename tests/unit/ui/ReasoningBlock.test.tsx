import { render } from 'ink-testing-library';
import React from 'react';
// tests/unit/ui/ReasoningBlock.test.tsx
import { describe, expect, it } from 'vitest';
import { ReasoningBlock } from '../../../src/ui/ReasoningBlock.js';

describe('ReasoningBlock', () => {
  it('renders streaming text expanded while phase=streaming', () => {
    const { lastFrame } = render(
      <ReasoningBlock text="thinking deeply" phase="streaming" durationMs={1200} />,
    );
    expect(lastFrame()).toContain('thinking deeply');
  });

  it('collapses to a single summary line when phase=complete', () => {
    const { lastFrame } = render(
      <ReasoningBlock
        text="long internal monologue spanning many words"
        phase="complete"
        durationMs={3400}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('long internal monologue');
    expect(frame).toMatch(/Reasoning.*3\.4s/);
  });

  it('shows expanded view when expanded prop is true even after complete', () => {
    const { lastFrame } = render(
      <ReasoningBlock text="full text here" phase="complete" durationMs={500} expanded />,
    );
    expect(lastFrame()).toContain('full text here');
  });
});
