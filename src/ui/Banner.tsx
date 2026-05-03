// src/ui/Banner.tsx
import { Box, Text } from 'ink';
import { useEffect, useState } from 'react';
import type React from 'react';
import { BANNER_FRAMERATE_FPS, BANNER_FRAMES } from './banner-art.js';

export type BannerInfo = {
  model: string;
  adapter: 'v3' | 'v4';
  cwd: string;
};

const TAGLINE = 'Autonomous MoE Network';

const QUOTES: readonly string[] = [
  "the early bird gets the worm, the second mouse gets the cheese, what's third?",
  'mycelium speaks in pulses below the leaf litter.',
  'if a tool runs without a human watching, did it really run?',
  'the third mouse builds the trap.',
  'every fungus is a federation of decisions.',
  'the agent that asks twice gets it right once.',
  'context lives a little longer than knowledge.',
  'patience is a recursive function with a high stack limit.',
  'spores travel further than instructions.',
  'the slow path is sometimes the only path that arrives.',
];

function pickQuote(): string {
  const idx = Math.floor(Math.random() * QUOTES.length);
  return QUOTES[idx] ?? QUOTES[0] ?? '';
}

/**
 * Splash banner mounted above the REPL turns log on every session start.
 * Renders the durdraw-authored mushroom + MYCELIATE block-art (animated when
 * the source has multiple frames) followed by a metadata line showing the
 * live model, adapter, and cwd. Re-generate the underlying art via
 * `pnpm tsx scripts/build-banner.ts` if `~/Myceliate/myceliate_title` changes.
 */
export function Banner({ model: _model, adapter, cwd }: BannerInfo): React.JSX.Element {
  const [frameIdx, setFrameIdx] = useState(0);
  // Pick a single quote per session at mount; useState lazy-init runs once.
  const [quote] = useState(() => pickQuote());

  // Cycle through frames at the source fps. Single-frame art skips the timer
  // entirely. Cleanup is unconditional so the timer never leaks across mount
  // cycles (relevant when the REPL re-renders App with a new banner instance).
  useEffect(() => {
    if (BANNER_FRAMES.length <= 1) return;
    const intervalMs = Math.max(1, Math.round(1000 / BANNER_FRAMERATE_FPS));
    const timer = setInterval(() => {
      setFrameIdx((i) => (i + 1) % BANNER_FRAMES.length);
    }, intervalMs);
    return () => clearInterval(timer);
  }, []);

  const frame = BANNER_FRAMES[frameIdx] ?? BANNER_FRAMES[0] ?? [];

  return (
    <Box flexDirection="column" marginBottom={1}>
      {frame.map((runs, rowIdx) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows are stable across frames.
        <Box key={rowIdx}>
          {runs.map((run, runIdx) => (
            <Text
              // biome-ignore lint/suspicious/noArrayIndexKey: runs within a row are stable.
              key={runIdx}
              {...(run.fg === 'inherit' ? {} : { color: run.fg })}
            >
              {run.text}
            </Text>
          ))}
        </Box>
      ))}
      <Box marginTop={1} paddingLeft={2}>
        <Text color="cyanBright">{TAGLINE}</Text>
        <Text color="gray">{`  ·  ${adapter.toUpperCase()} adapter`}</Text>
        <Text color="gray">{`  ·  ${cwd}`}</Text>
      </Box>
      <Box paddingLeft={2}>
        <Text color="gray" italic>
          {`"${quote}"`}
        </Text>
      </Box>
    </Box>
  );
}
