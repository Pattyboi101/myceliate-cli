// src/ui/ReasoningBlock.tsx
import { Box, Text } from 'ink';
import type React from 'react';

export type ReasoningPhase = 'streaming' | 'complete';

export type ReasoningBlockProps = {
  text: string;
  phase: ReasoningPhase;
  durationMs: number;
  expanded?: boolean;
  /**
   * Phase 2.5 (T38): optional model string for the routing indicator.
   * When provided, the header shows "Reasoning (Pro)", "Reasoning (Flash)",
   * or "Reasoning ({model})" for env-override cases. When absent, renders
   * the plain "Reasoning" label (backwards-compatible default).
   */
  model?: string;
};

/**
 * Returns the human-readable label for the Reasoning header based on the
 * dispatched model. Known DeepSeek V4 variants get short labels; any other
 * model string is shown verbatim in parentheses; undefined renders "Reasoning".
 */
const labelFor = (model: string | undefined): string => {
  if (model === undefined) return 'Reasoning';
  if (model === 'deepseek-v4-pro') return 'Reasoning (Pro)';
  if (model === 'deepseek-v4-flash') return 'Reasoning (Flash)';
  return `Reasoning (${model})`;
};

export function ReasoningBlock({
  text,
  phase,
  durationMs,
  expanded = false,
  model,
}: ReasoningBlockProps): React.JSX.Element {
  const label = labelFor(model);
  const showFull = phase === 'streaming' || expanded;
  if (!showFull) {
    return (
      <Text dimColor>
        {'> '} {label} ({(durationMs / 1000).toFixed(1)}s) — press Tab to expand
      </Text>
    );
  }
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
      <Text dimColor italic>
        ── {label} {phase === 'streaming' ? '(streaming…)' : `(${(durationMs / 1000).toFixed(1)}s)`}{' '}
        ──
      </Text>
      <Text dimColor>{text}</Text>
    </Box>
  );
}
