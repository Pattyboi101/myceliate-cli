// src/ui/ToolCallCard.tsx
import { Box, Text } from 'ink';
import type React from 'react';

export type ToolCallCardState = {
  id: string;
  name: string;
  args: unknown;
  status: 'running' | 'completed' | 'failed' | 'rejected';
  durationMs?: number;
  preview?: string;
  error?: string;
};

const STATUS_GLYPH: Record<ToolCallCardState['status'], string> = {
  running: '⠋',
  completed: '✓',
  failed: '✗',
  rejected: '∅',
};

const STATUS_COLOR: Record<ToolCallCardState['status'], string> = {
  running: 'yellow',
  completed: 'green',
  failed: 'red',
  rejected: 'magenta',
};

function summariseArgs(args: unknown): string {
  if (args === null || typeof args !== 'object') return String(args);
  // The most common arg shape is {command: string} or {path: string}.
  const obj = args as Record<string, unknown>;
  const first = Object.values(obj)[0];
  return typeof first === 'string' ? first : JSON.stringify(obj);
}

export function ToolCallCard({ card }: { card: ToolCallCardState }): React.JSX.Element {
  return (
    <Box flexDirection="column" marginY={1} borderStyle="round" paddingX={1}>
      <Box>
        <Text color={STATUS_COLOR[card.status]}>{STATUS_GLYPH[card.status]} </Text>
        <Text bold>{card.name}</Text>
        <Text color="gray">{` ${summariseArgs(card.args)}`}</Text>
        {card.durationMs !== undefined && card.status !== 'running' && (
          <Text color="gray">{`  ${card.durationMs}ms`}</Text>
        )}
      </Box>
      {card.status === 'completed' && card.preview && (
        <Box marginTop={1}>
          <Text color="gray">{card.preview}</Text>
        </Box>
      )}
      {(card.status === 'failed' || card.status === 'rejected') && card.error && (
        <Box marginTop={1}>
          <Text color="red">{card.error}</Text>
        </Box>
      )}
    </Box>
  );
}
