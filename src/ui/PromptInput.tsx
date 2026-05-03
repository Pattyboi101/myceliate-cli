// src/ui/PromptInput.tsx
import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import type React from 'react';

/**
 * Inline Ink prompt input for the REPL loop. Renders a single-line buffer
 * with a green chevron prompt. Enter submits and clears; backspace edits.
 *
 * U3-compliant: no Clack mid-Ink-render. The agent loop owns input via Ink
 * for the entire session (Clack only runs pre-Ink during onboarding).
 */
export function PromptInput({ onSubmit }: { onSubmit: (text: string) => void }): React.JSX.Element {
  const [buffer, setBuffer] = useState('');

  useInput((input, key) => {
    if (key.return) {
      // Submit on Enter; clear the buffer for the next turn.
      const submitted = buffer;
      setBuffer('');
      onSubmit(submitted);
      return;
    }
    if (key.backspace || key.delete) {
      setBuffer((b) => b.slice(0, -1));
      return;
    }
    if (key.tab) return; // Tab is reserved for ReasoningBlock toggle.
    if (input.length > 0 && !key.ctrl && !key.meta) {
      setBuffer((b) => b + input);
    }
  });

  return (
    <Box marginTop={1}>
      <Text color="green">{'> '}</Text>
      <Text>{buffer}</Text>
      <Text color="gray">{'▎'}</Text>
    </Box>
  );
}
