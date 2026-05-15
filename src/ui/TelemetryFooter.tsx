import { Box, Text } from 'ink';
import type { FC } from 'react';
import { formatCostUSD } from '../runtime/costCalculator.js';

interface SubagentStatus {
  step: number;
  durationMs: number;
}

interface TelemetryFooterProps {
  lastTurnInputTokens: number;
  lastTurnOutputTokens: number;
  lastTurnCostUSD: number;
  sessionTotalCostUSD: number;
  subagent?: SubagentStatus;
}

const formatTokens = (n: number): string => {
  if (n < 1000) return `${n}`;
  return `${(n / 1000).toFixed(1)}k`;
};

const formatDuration = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
};

export const TelemetryFooter: FC<TelemetryFooterProps> = ({
  lastTurnInputTokens,
  lastTurnOutputTokens,
  lastTurnCostUSD,
  sessionTotalCostUSD,
  subagent,
}) => (
  <Box flexDirection="column">
    <Box justifyContent="space-between">
      <Text color="gray">
        {`last turn: ${formatTokens(lastTurnInputTokens)} in / ${formatTokens(lastTurnOutputTokens)} out | ${formatCostUSD(lastTurnCostUSD)}`}
      </Text>
      <Text color="green">{`session total: ${formatCostUSD(sessionTotalCostUSD, 2)}`}</Text>
    </Box>
    {subagent !== undefined ? (
      <Text color="cyan">
        {`subagent: step ${subagent.step} (${formatDuration(subagent.durationMs)})`}
      </Text>
    ) : null}
  </Box>
);
