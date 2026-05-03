// src/ui/ReasoningBlock.tsx
import { Box, Text } from 'ink';
import type React from 'react';

export type ReasoningPhase = 'streaming' | 'complete';

export type ReasoningBlockProps = {
  text: string;
  phase: ReasoningPhase;
  durationMs: number;
  expanded?: boolean;
};

export function ReasoningBlock({
  text,
  phase,
  durationMs,
  expanded = false,
}: ReasoningBlockProps): React.JSX.Element {
  const showFull = phase === 'streaming' || expanded;
  if (!showFull) {
    return (
      <Text dimColor>
        {'> '} Reasoning ({(durationMs / 1000).toFixed(1)}s) — press Tab to expand
      </Text>
    );
  }
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
      <Text dimColor italic>
        ── reasoning{' '}
        {phase === 'streaming' ? '(streaming…)' : `(${(durationMs / 1000).toFixed(1)}s)`} ──
      </Text>
      <Text dimColor>{text}</Text>
    </Box>
  );
}
