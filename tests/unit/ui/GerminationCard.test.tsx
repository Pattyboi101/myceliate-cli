import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { GerminationCard } from '../../../src/ui/GerminationCard.js';

describe('GerminationCard', () => {
  it('shows the spore name and message', () => {
    const { lastFrame } = render(
      <GerminationCard
        spore="solo-business"
        accent_color="#c5a45f"
        message="Germinating solo-business spore"
      />,
    );
    const out = lastFrame() ?? '';
    expect(out).toMatch(/solo-business/);
    expect(out).toMatch(/Germinating/);
  });
});
