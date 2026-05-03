// src/ui/App.tsx
import { Box, Text } from 'ink';
import type React from 'react';
import type { ApprovalRequest, ApprovalResponse } from '../security/hitlGate.js';
import { ApprovalPrompt } from './ApprovalPrompt.js';
import { ContentStream } from './ContentStream.js';
import { ReasoningBlock } from './ReasoningBlock.js';

export type ReasoningState = { text: string; phase: 'streaming' | 'complete'; startedAtMs: number };

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
          durationMs={Date.now() - state.reasoning.startedAtMs}
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
