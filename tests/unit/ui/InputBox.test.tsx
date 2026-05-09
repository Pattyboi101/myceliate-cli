import { createRequire } from 'node:module';
import { render } from 'ink-testing-library';
import React from 'react';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InputBox } from '../../../src/ui/InputBox.js';

// Resolve chalk via ink's module graph and mutate its `.level` to force
// truecolor output. Required because ink-testing-library is non-TTY, so
// chalk's auto-detection picks level 0 (no escapes) — without this the
// test would only see plain box-drawing chars (the Phase 21 smoke gap).
const req = createRequire(import.meta.url);
const inkReq = createRequire(req.resolve('ink'));
const chalkPath = inkReq.resolve('chalk');
const chalkMod = (await import(chalkPath)) as { default: { level: 0 | 1 | 2 | 3 } };
const chalk = chalkMod.default;

let prevLevel: 0 | 1 | 2 | 3;
beforeAll(() => {
  prevLevel = chalk.level;
  chalk.level = 3; // truecolor
  // Defend against silent failure if chalk ever exposes `level` as a getter-only
  // property — without this guard, mutation would no-op and tests would pass
  // against a non-truecolor fallback rather than the production ANSI escape.
  if (chalk.level !== 3) {
    throw new Error('chalk.level mutation did not take effect — ANSI assertions would be invalid');
  }
});
afterAll(() => {
  chalk.level = prevLevel;
});

describe('InputBox border colour', () => {
  // Phase 24 Task 2: closes test gap B from Phase 21. Replaces the
  // box-drawing-chars-only smoke with assertions on the actual ANSI
  // colour escape — ink/chalk emits ESC[38;2;R;G;Bm truecolor at level 3
  // for the active spore's accent hex, vs ESC[90m basic gray for no spore.

  it('renders border in active spore accent_color when spore is active', () => {
    const { lastFrame } = render(
      <InputBox
        activeSpore={{ name: 'research', accent_color: '#4a90c4' }}
        value=""
        onChange={() => {}}
        onSubmit={() => {}}
      />,
    );
    const frame = lastFrame() ?? '';
    // Hex #4a90c4 = R74 G144 B196. With chalk.level=3, ink emits ANSI
    // 24-bit truecolor: ESC[38;2;74;144;196m
    expect(frame).toContain('\x1b[38;2;74;144;196m');
    // Border characters present (sanity that the border is still drawn).
    expect(frame).toMatch(/[╭─╮│╰╯]/);
    // Sanity: the gray default escape is NOT used here.
    expect(frame).not.toContain('\x1b[90m╭');
  });

  it('renders border in gray (default) when no spore is active', () => {
    const { lastFrame } = render(
      <InputBox activeSpore={null} value="" onChange={() => {}} onSubmit={() => {}} />,
    );
    const frame = lastFrame() ?? '';
    // chalk maps the named 'gray' colour to ESC[90m (basic ANSI bright black).
    expect(frame).toContain('\x1b[90m');
    // Sanity: not emitting an accent-colour truecolor escape.
    expect(frame).not.toContain('\x1b[38;2;74;144;196m');
    // Border characters present.
    expect(frame).toMatch(/[╭─╮│╰╯]/);
  });
});
