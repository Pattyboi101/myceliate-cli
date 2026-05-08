// src/ui/GerminationCard.tsx
import { Box, Text } from 'ink';
import type React from 'react';

export interface GerminationCardProps {
  spore: string;
  accent_color: string;
  message: string;
}

/**
 * Phase 21: inline stream card rendered when a GerminationEvent arrives.
 * Accent-coloured banner with spore name + germination message.
 * Visual sibling of Phase 13's ToolCallCard — same single-border inline pattern.
 */
export function GerminationCard({
  spore,
  accent_color,
  message,
}: GerminationCardProps): React.JSX.Element {
  return (
    <Box borderStyle="single" borderColor={accent_color} paddingX={1} marginY={0}>
      <Text color={accent_color}>{message}</Text>
      <Box marginLeft={1}>
        <Text dimColor>({spore})</Text>
      </Box>
    </Box>
  );
}
