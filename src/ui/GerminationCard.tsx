// src/ui/GerminationCard.tsx
import { Box, Text } from 'ink';
import type React from 'react';

export interface GerminationCardProps {
  spore: string;
  accent_color: string;
  message: string;
  /**
   * Phase 24 Task 1: when true, render a one-line summary instead of the full
   * bordered banner. Closes spec §7.2 deviation flagged in v1.3 Phase 21
   * plan-pointer note. Caller (App.tsx) flips this on first content_delta.
   */
  collapsed?: boolean;
}

/**
 * Phase 21: inline stream card rendered when a GerminationEvent arrives.
 * Accent-coloured banner with spore name + germination message.
 * Visual sibling of Phase 13's ToolCallCard — same single-border inline pattern.
 *
 * Phase 24 Task 1: collapses to a one-line summary on first content_delta.
 * The full bordered banner is only shown pre-stream; once the answer begins
 * streaming, the card shrinks to `▸ <spore> (<message>)` so the inline card
 * doesn't push the streaming content down the screen.
 */
export function GerminationCard({
  spore,
  accent_color,
  message,
  collapsed = false,
}: GerminationCardProps): React.JSX.Element {
  if (collapsed) {
    return (
      <Box marginY={0}>
        <Text color={accent_color}>{`▸ ${spore}`}</Text>
        <Text dimColor>{` (${message})`}</Text>
      </Box>
    );
  }
  return (
    <Box borderStyle="single" borderColor={accent_color} paddingX={1} marginY={0}>
      <Text color={accent_color}>{message}</Text>
      <Box marginLeft={1}>
        <Text dimColor>({spore})</Text>
      </Box>
    </Box>
  );
}
