// tests/unit/ui/PromptInput.test.tsx
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { PromptInput } from '../../../src/ui/PromptInput.js';

describe('PromptInput', () => {
  it('echoes typed characters into the visible buffer', async () => {
    const { stdin, lastFrame } = render(<PromptInput onSubmit={() => {}} />);
    // ink-testing-library quirk: 'readable' attaches in useEffect; wait one tick.
    await new Promise((r) => setTimeout(r, 50));
    stdin.write('hi');
    await new Promise((r) => setTimeout(r, 10));
    expect(lastFrame()).toContain('hi');
  });

  it('calls onSubmit with the buffer when Enter is pressed and clears the buffer', async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(<PromptInput onSubmit={onSubmit} />);
    await new Promise((r) => setTimeout(r, 50));
    stdin.write('hello');
    await new Promise((r) => setTimeout(r, 10));
    stdin.write('\r'); // Enter
    await new Promise((r) => setTimeout(r, 10));
    expect(onSubmit).toHaveBeenCalledWith('hello');
    expect(lastFrame()).not.toContain('hello');
  });

  it('handles backspace by trimming the last character', async () => {
    const { stdin, lastFrame } = render(<PromptInput onSubmit={() => {}} />);
    await new Promise((r) => setTimeout(r, 50));
    stdin.write('abc');
    await new Promise((r) => setTimeout(r, 10));
    stdin.write('\x7f'); // DEL / backspace
    await new Promise((r) => setTimeout(r, 10));
    expect(lastFrame()).toContain('ab');
    expect(lastFrame()).not.toContain('abc');
  });
});
