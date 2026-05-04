// src/ui/App.tsx
import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import type React from 'react';
import type { ApprovalRequest, ApprovalResponse } from '../security/hitlGate.js';
import { ApprovalPrompt } from './ApprovalPrompt.js';
import { Banner, type BannerInfo } from './Banner.js';
import { ContentStream } from './ContentStream.js';
import { PromptInput } from './PromptInput.js';
import { ReasoningBlock } from './ReasoningBlock.js';
import { ToolCallCard, type ToolCallCardState } from './ToolCallCard.js';

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
  /** Tool-call cards for the current turn (cleared on turn_complete). */
  toolCalls: ToolCallCardState[];
};

export function App({
  state,
  banner,
  onApprovalResponse,
  onPromptSubmit,
}: {
  state: AppState;
  /** Optional splash banner (model + adapter + cwd). Omitted in unit fixtures. */
  banner?: BannerInfo;
  onApprovalResponse?: (r: ApprovalResponse) => void;
  onPromptSubmit?: (text: string) => void;
}): React.JSX.Element {
  // U1 mandates the reasoning trace is "Toggleable via keyboard." Tab flips
  // expansion; ReasoningBlock's collapsed view advertises this affordance.
  // Tab dispatch is precedence-based: reasoning toggle first; otherwise toggle
  // the most-recent tool card's expansion when reasoning is null.
  const [reasoningExpanded, setReasoningExpanded] = useState(false);
  // Phase 15 review m3: cardExpanded is a single boolean controlling the
  // LATEST card's expansion via `i === state.toolCalls.length - 1`. It is NOT
  // reset between turns — if the user expands a card in turn N, the first card
  // of turn N+1 inherits `cardExpanded === true`. This is acceptable in v1.1
  // because `state.toolCalls` is cleared at the REPL boundary (onTurnComplete
  // + readNextPrompt resolver in src/index.ts), so there's a render cycle with
  // an empty toolCalls before the new turn's first tool_call arrives. v1.2 may
  // add a useEffect that resets when toolCalls transitions to empty, or move
  // to a per-card `Set<string>` for richer expand semantics.
  const [cardExpanded, setCardExpanded] = useState(false);
  useInput((_input, key) => {
    if (key.tab) {
      if (state.reasoning) {
        setReasoningExpanded((p) => !p);
      } else if (state.toolCalls.length > 0) {
        setCardExpanded((p) => !p);
      }
    }
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      {banner && <Banner {...banner} />}
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
          {state.toolCalls.map((card, i) => (
            <ToolCallCard
              key={card.id}
              card={card}
              expanded={cardExpanded && i === state.toolCalls.length - 1}
            />
          ))}
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
