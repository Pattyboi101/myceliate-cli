// src/ui/InputBox.tsx
import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import type React from 'react';
import type { ActiveSporeState } from './store.js';

export interface InputBoxProps {
  activeSpore: ActiveSporeState | null;
  /** If provided, used as a controlled value (for testing). If omitted, internal buffer is used. */
  value?: string;
  onChange?: (v: string) => void;
  onSubmit: (v: string) => void;
  placeholder?: string;
}

/**
 * Phase 21: bordered prompt input. Border colour tracks the active spore's
 * accent_color; falls back to 'gray' when no spore is germinated.
 *
 * Self-contained like PromptInput (internal buffer state). Accepts optional
 * controlled value/onChange for testing. The Box wrapping provides the
 * dynamic borderColor per spec §5.8.
 *
 * Uses Ink's native useInput — ink-text-input is not a project dependency.
 */
export function InputBox({
  activeSpore,
  value: controlledValue,
  onChange,
  onSubmit,
  placeholder,
}: InputBoxProps): React.JSX.Element {
  const [internalBuffer, setInternalBuffer] = useState('');
  // Use controlled value when provided, otherwise internal buffer.
  const value = controlledValue !== undefined ? controlledValue : internalBuffer;
  const borderColor = activeSpore?.accent_color ?? 'gray';

  useInput((input, key) => {
    if (key.return) {
      const submitted = value;
      if (controlledValue === undefined) setInternalBuffer('');
      onSubmit(submitted);
      return;
    }
    // Ctrl+D → /quit (shell EOF idiom, matches PromptInput).
    if (key.ctrl && input === 'd') {
      onSubmit('/quit');
      return;
    }
    if (key.backspace || key.delete) {
      const next = value.slice(0, -1);
      if (controlledValue === undefined) setInternalBuffer(next);
      onChange?.(next);
      return;
    }
    if (key.tab) return; // Tab reserved for ReasoningBlock toggle.
    if (input.length > 0 && !key.ctrl && !key.meta) {
      const next = value + input;
      if (controlledValue === undefined) setInternalBuffer(next);
      onChange?.(next);
    }
  });

  const displayValue = value.length > 0 ? value : (placeholder ?? '');
  const isPlaceholder = value.length === 0 && placeholder !== undefined;

  return (
    <Box borderStyle="round" borderColor={borderColor} flexDirection="column" marginTop={1}>
      <Box paddingX={1}>
        <Text color="green">{'> '}</Text>
        <Text dimColor={isPlaceholder}>{displayValue}</Text>
        <Text color="gray">{'▎'}</Text>
      </Box>
      <Box paddingX={1}>
        <Text color="gray" dimColor>
          {'  /quit or Ctrl+D to exit'}
        </Text>
      </Box>
    </Box>
  );
}
