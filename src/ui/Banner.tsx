// src/ui/Banner.tsx
import { Box, Text } from 'ink';
import type React from 'react';
import { BANNER_ROWS } from './banner-art.js';

export type BannerInfo = {
  model: string;
  adapter: 'v3' | 'v4';
  cwd: string;
};

/**
 * Splash banner mounted above the REPL turns log on every session start.
 * Renders the durdraw-authored mushroom + MYCELIATE block-art (80×9, neon
 * blue gradient palette: xterm 16-21 + 255) followed by a single metadata
 * line showing the live model, adapter, and cwd. Re-generate the underlying
 * art via `pnpm tsx scripts/build-banner.ts` if `~/Myceliate/myceliate_title`
 * changes.
 */
export function Banner({ model, adapter, cwd }: BannerInfo): React.JSX.Element {
  return (
    <Box flexDirection="column" marginBottom={1}>
      {BANNER_ROWS.map((runs, rowIdx) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows are static and stable.
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
        <Text color="cyanBright">{model}</Text>
        <Text color="gray">{`  ·  ${adapter.toUpperCase()} adapter`}</Text>
        <Text color="gray">{`  ·  ${cwd}`}</Text>
      </Box>
    </Box>
  );
}
