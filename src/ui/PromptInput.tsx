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
 *
 * Phase 12 review m1 fix: Ctrl+D submits `/quit`, matching shell EOF idiom.
 * Empty Enter no longer exits silently — `''` was removed from QUIT_TOKENS in
 * replSession.ts and an explicit hint is rendered below the buffer.
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
    // Ctrl+D → /quit (shell EOF idiom).
    if (key.ctrl && input === 'd') {
      onSubmit('/quit');
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
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color="green">{'> '}</Text>
        <Text>{buffer}</Text>
        <Text color="gray">{'▎'}</Text>
      </Box>
      <Text color="gray" dimColor>
        {'  /quit or Ctrl+D to exit'}
      </Text>
    </Box>
  );
}
