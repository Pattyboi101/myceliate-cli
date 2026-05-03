// src/ui/App.tsx
import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import type React from 'react';
import type { ApprovalRequest, ApprovalResponse } from '../security/hitlGate.js';
import { ApprovalPrompt } from './ApprovalPrompt.js';
import { ContentStream } from './ContentStream.js';
import { PromptInput } from './PromptInput.js';
import { ReasoningBlock } from './ReasoningBlock.js';

export type ReasoningState = {
  text: string;
  phase: 'streaming' | 'complete';
  startedAtMs: number;
  /**
   * F4: set when the reasoning phase flips from `streaming` to `complete`.
   * Without this, App's render-time `Date.now() - startedAtMs` calculation kept
   * ticking up while the answer streamed (a 3 s reasoning displayed as 8 s by
   * the time the answer finished).
   */
  endedAtMs?: number;
};

export type CompletedTurn = {
  userInput: string;
  content: string;
};

export type AppState = {
  userInput: string;
  reasoning: ReasoningState | null;
  content: string;
  approvalRequest: ApprovalRequest | null;
  /** REPL phase: streaming = a turn is in flight; awaiting_input = ready for next prompt. */
  phase: 'streaming' | 'awaiting_input';
  /** Append-only log of completed turns (rendered above the live region). */
  turns: CompletedTurn[];
};

export function App({
  state,
  onApprovalResponse,
  onPromptSubmit,
}: {
  state: AppState;
  onApprovalResponse?: (r: ApprovalResponse) => void;
  onPromptSubmit?: (text: string) => void;
}): React.JSX.Element {
  // U1 mandates the reasoning trace is "Toggleable via keyboard." Tab flips
  // expansion; ReasoningBlock's collapsed view advertises this affordance.
  const [reasoningExpanded, setReasoningExpanded] = useState(false);
  useInput((_input, key) => {
    if (key.tab) setReasoningExpanded((prev) => !prev);
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      {state.turns.map((t, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: append-only log, indices are stable.
        <Box key={i} flexDirection="column" marginBottom={1}>
          <Box>
            <Text color="green">{'> '}</Text>
            <Text>{t.userInput}</Text>
          </Box>
          <Text>{t.content}</Text>
        </Box>
      ))}
      {state.phase === 'streaming' && (
        <>
          <Box marginBottom={1}>
            <Text color="green">{'> '}</Text>
            <Text>{state.userInput}</Text>
          </Box>
          {state.reasoning !== null && (
            <ReasoningBlock
              text={state.reasoning.text}
              phase={state.reasoning.phase}
              durationMs={(state.reasoning.endedAtMs ?? Date.now()) - state.reasoning.startedAtMs}
              expanded={reasoningExpanded}
            />
          )}
          {state.content.length > 0 && <ContentStream text={state.content} />}
        </>
      )}
      {state.approvalRequest !== null && (
        <ApprovalPrompt
          request={state.approvalRequest}
          onResponse={onApprovalResponse ?? (() => {})}
        />
      )}
      {state.phase === 'awaiting_input' && <PromptInput onSubmit={onPromptSubmit ?? (() => {})} />}
    </Box>
  );
}
