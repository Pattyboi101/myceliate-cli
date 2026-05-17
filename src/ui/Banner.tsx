// src/ui/Banner.tsx
import { Box, Text } from 'ink';
import { useState } from 'react';
import type React from 'react';
import { BANNER_ROWS } from './banner-art.js';

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
 * Renders the first frame of the durdraw-authored mushroom + MYCELIATE
 * block-art (static — see git history for the animated variant) followed
 * by a metadata line showing the live adapter, cwd, and a session quote.
 * Re-generate the underlying art via `pnpm tsx scripts/build-banner.ts`
 * if `~/Myceliate/myceliate_title` changes.
 */
export function Banner({ model: _model, adapter, cwd }: BannerInfo): React.JSX.Element {
  // Pick a single quote per session at mount; useState lazy-init runs once.
  const [quote] = useState(() => pickQuote());

  return (
    <Box flexDirection="column" marginBottom={1}>
      {BANNER_ROWS.map((runs, rowIdx) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows are static.
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
