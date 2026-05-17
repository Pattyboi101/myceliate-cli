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

const COLLAPSED_LINES = 5;

const REDACT_RE = /\[REDACTED:[^\]]+\]/g;

function HighlightedLine({ line }: { line: string }): React.JSX.Element {
  // Split on the redaction marker to colour-segment the line.
  const parts: Array<{ text: string; redacted: boolean }> = [];
  let lastIndex = 0;
  for (const m of line.matchAll(REDACT_RE)) {
    if (m.index === undefined) continue;
    if (m.index > lastIndex) parts.push({ text: line.slice(lastIndex, m.index), redacted: false });
    parts.push({ text: m[0], redacted: true });
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < line.length) parts.push({ text: line.slice(lastIndex), redacted: false });
  return (
    <Text>
      {parts.map((p, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: stable segments.
        <Text key={i} color={p.redacted ? 'magenta' : 'gray'}>
          {p.text}
        </Text>
      ))}
    </Text>
  );
}

export function ToolCallCard({
  card,
  expanded = false,
}: { card: ToolCallCardState; expanded?: boolean }): React.JSX.Element {
  const previewLines = card.preview ? card.preview.split('\n') : [];
  const visibleLines = expanded ? previewLines : previewLines.slice(0, COLLAPSED_LINES);
  const hiddenCount = previewLines.length - visibleLines.length;

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
      {card.status === 'completed' && previewLines.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {visibleLines.map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: stable lines.
            <HighlightedLine key={i} line={line} />
          ))}
          {hiddenCount > 0 && <Text color="gray">{`… ${hiddenCount} more lines`}</Text>}
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
