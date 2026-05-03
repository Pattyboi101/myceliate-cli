// src/ui/App.tsx
import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import type React from 'react';
import type { ApprovalRequest, ApprovalResponse } from '../security/hitlGate.js';
import { ApprovalPrompt } from './ApprovalPrompt.js';
import { ContentStream } from './ContentStream.js';
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

export type AppState = {
  userInput: string;
  reasoning: ReasoningState | null;
  content: string;
  approvalRequest: ApprovalRequest | null;
};

export function App({
  state,
  onApprovalResponse,
}: { state: AppState; onApprovalResponse?: (r: ApprovalResponse) => void }): React.JSX.Element {
  // U1 mandates the reasoning trace is "Toggleable via keyboard." Tab flips
  // expansion; ReasoningBlock's collapsed view advertises this affordance.
  const [reasoningExpanded, setReasoningExpanded] = useState(false);
  useInput((_input, key) => {
    if (key.tab) setReasoningExpanded((prev) => !prev);
  });

  return (
    <Box flexDirection="column" paddingX={1}>
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
      {state.approvalRequest !== null && (
        <ApprovalPrompt
          request={state.approvalRequest}
          onResponse={onApprovalResponse ?? (() => {})}
        />
      )}
    </Box>
  );
}
