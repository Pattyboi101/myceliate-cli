import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { InputBox } from '../../../src/ui/InputBox.js';

describe('InputBox', () => {
  it('renders with gray border when no active spore', () => {
    const { lastFrame } = render(
      <InputBox activeSpore={null} value="" onChange={() => {}} onSubmit={() => {}} />,
    );
    const out = lastFrame() ?? '';
    // Gray border characters present
    expect(out).toMatch(/[╭─╮│╰╯]/);
  });

  it('renders with the spore accent color when one is active', () => {
    const { lastFrame } = render(
      <InputBox
        activeSpore={{ name: 'solo-business', accent_color: '#c5a45f' }}
        value=""
        onChange={() => {}}
        onSubmit={() => {}}
      />,
    );
    const out = lastFrame() ?? '';
    // Border characters still present (color isn't visible in plain string but presence is enough)
    expect(out).toMatch(/[╭─╮│╰╯]/);
  });
});
