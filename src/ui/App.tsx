// src/ui/App.tsx
import { Box, Static, Text, useInput } from 'ink';
import { useState } from 'react';
import type React from 'react';
import type { CavemanState } from '../runtime/cavemanMode.js';
import type { ApprovalRequest, ApprovalResponse } from '../security/hitlGate.js';
import { ApprovalPrompt } from './ApprovalPrompt.js';
import { Banner, type BannerInfo } from './Banner.js';
import { ContentStream } from './ContentStream.js';
import { GerminationCard } from './GerminationCard.js';
import { InputBox } from './InputBox.js';
import { ReasoningBlock } from './ReasoningBlock.js';
import { TelemetryFooter } from './TelemetryFooter.js';
import { ToolCallCard, type ToolCallCardState } from './ToolCallCard.js';
import type { ActiveSporeState } from './store.js';

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
  /** FIFO queue of pending HITL approvals. The head is rendered as
   * <ApprovalPrompt>; tail entries wait. Phase 17 m5 fix: replaces the
   * single-slot approvalRequest field; src/index.ts maintains a parallel
   * Map<requestId, fn> for resolver lookup. */
  approvalRequests: ApprovalRequest[];
  /** REPL phase: streaming = a turn is in flight; awaiting_input = ready for next prompt. */
  phase: 'streaming' | 'awaiting_input';
  /** Append-only log of completed turns (rendered above the live region). */
  turns: CompletedTurn[];
  /** Tool-call cards for the current turn (cleared on turn_complete). */
  toolCalls: ToolCallCardState[];
  /**
   * Phase 19: active sector spore for UI state (border color, etc.).
   * Phase 21: wired to <InputBox> borderColor. Uses ActiveSporeState from store.ts.
   */
  activeSpore: ActiveSporeState | null;
  /**
   * Phase 21: last germination event data for rendering <GerminationCard>
   * inline in the stream. Cleared on turn_complete. Optional so existing
   * fixtures without this field continue to pass (treats undefined as null).
   */
  germinationCard?: ActiveSporeState | null;
  /**
   * Phase 23 Case 8: security-relevant allowlist drift warnings (stale spore
   * pin, unknown tool names in allowlist, coordination tools in allowlist).
   * Rendered as a persistent yellow banner. REQUIRED (`string[]`) — Phase 23
   * post-review fix: making this optional caused the banner to silently
   * disappear after the first turn when full-reconstruction rerenders
   * (`onTurnComplete`/`readNextPrompt`) omitted the field. With the field
   * required, any AppState construction that drops this signal fails at
   * compile time. Security-relevant signals must NOT be silently erased.
   */
  bootWarnings: string[];
  /**
   * Phase 2.5 (T38): model string from the most recent `request_started`
   * stream event. Threaded into <ReasoningBlock model={...}> to render the
   * routing indicator ("Reasoning (Pro)" / "Reasoning (Flash)" etc.).
   * Optional for backwards compatibility with existing fixtures that do not
   * supply the field (treated as undefined → "Reasoning" plain label).
   */
  activeModel?: string;
  /**
   * Phase 2.5 (T40): token counts from the most recent completed turn.
   * Populated by the onCostEstimate callback; undefined until the first turn
   * with non-zero usage completes.
   */
  lastTurnUsage?: { inputTokens: number; outputTokens: number };
  /**
   * Phase 2.5 (T40): dollar cost of the most recent completed turn (USD).
   * Zero until the first cost estimate arrives.
   */
  lastTurnCost: number;
  /**
   * Phase 2.5 (T40): accumulated dollar cost across all turns this session (USD).
   */
  sessionTotalCost: number;
  /**
   * Phase 2.5 (T40): current subagent step in flight, if any.
   * Set on `subagent_step` stream events; cleared on `turn_complete`.
   */
  subagentStatus?: { step: number; durationMs: number };
};

export function App({
  state,
  banner,
  sessionId,
  cavemanState,
  onApprovalResponse,
  onPromptSubmit,
}: {
  state: AppState;
  /** Optional splash banner (model + adapter + cwd). Omitted in unit fixtures. */
  banner?: BannerInfo;
  /**
   * Phase 2.5 (T40): session UUID rendered in the top banner.
   * Only the first 8 chars are shown for brevity.
   * Optional — when absent the top banner is not rendered (unit fixtures).
   */
  sessionId?: string;
  /**
   * Phase 2.5 (T40): mutable shared reference to caveman state.
   * Read on every render so the banner reflects the current toggle without
   * requiring a dedicated state field (the object is mutated by the slash
   * handler; passing the reference ensures we always see the live value).
   * Optional — when absent caveman indicator is not rendered.
   */
  cavemanState?: CavemanState;
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
      {/* Phase 2.5 (T40): static top banner — session id + caveman indicator.
          Rendered only when sessionId is provided (production path). Unit
          fixtures omit sessionId so this block is invisible in tests that
          don't assert on it, keeping fixture setup minimal. */}
      {sessionId !== undefined && (
        <Box borderStyle="round" borderColor="gray" paddingX={1} data-testid="session-banner">
          <Text>
            {'myceliate-cli | session '}
            {sessionId.slice(0, 8)}
            {cavemanState !== undefined && (
              <Text>
                {' | '}
                <Text color={cavemanState.active ? 'yellow' : 'gray'}>
                  {cavemanState.active ? 'caveman ON' : 'caveman OFF'}
                </Text>
              </Text>
            )}
          </Text>
        </Box>
      )}
      {/* Boot banner (durdraw ASCII art) wrapped in <Static>: this content is
          committed to stdout ONCE at first mount and never re-rendered. Without
          this wrap, every App state change (caveman toggle, cost_estimated event,
          subagent_step event, any rerender) caused Ink to re-emit the 26-line
          banner art, accumulating in terminal scrollback and pushing the dynamic
          region (active turn + telemetry footer + InputBox) off-screen. T40
          surfaced this via walk-point 11 step 4 manual smoke. */}
      <Static items={banner ? [banner] : []}>{(b, i) => <Banner key={i} {...b} />}</Static>
      {/* Phase 23 Case 8: security-relevant boot warnings (stale spore pin,
          unknown/coordination tools in allowlist). Persistent yellow banner —
          these are not transient progress messages, they signal a security
          state the user should be aware of for the entire session. */}
      {state.bootWarnings.length > 0 && (
        <Box
          flexDirection="column"
          borderStyle="single"
          borderColor="yellow"
          marginBottom={1}
          data-testid="boot-warnings-banner"
        >
          {state.bootWarnings.map((w, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: append-only, stable indices.
            <Text key={i} color="yellow">{`[!] ${w}`}</Text>
          ))}
        </Box>
      )}
      {/* History: completed turns rendered via Static for Ink's scroll optimisation. */}
      <Static items={state.turns}>
        {(t, i) => (
          <Box key={i} flexDirection="column" marginBottom={1}>
            <Box>
              <Text color="green">{'> '}</Text>
              <Text>{t.userInput}</Text>
            </Box>
            <Text>{t.content}</Text>
          </Box>
        )}
      </Static>
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
              {...(state.activeModel !== undefined ? { model: state.activeModel } : {})}
            />
          )}
          {state.toolCalls.map((card, i) => (
            <ToolCallCard
              key={card.id}
              card={card}
              expanded={cardExpanded && i === state.toolCalls.length - 1}
            />
          ))}
          {/* Phase 21: show GerminationCard inline when a germination event arrived this turn.
              Phase 24 Task 1: card collapses to a one-line summary on first content_delta
              (i.e. once `state.content.length > 0`). Closes spec §7.2 deviation. */}
          {state.germinationCard && (
            <GerminationCard
              spore={state.germinationCard.name}
              accent_color={state.germinationCard.accent_color}
              message={`Germinating ${state.germinationCard.name} spore`}
              collapsed={state.content.length > 0}
            />
          )}
          {state.content.length > 0 && <ContentStream text={state.content} />}
        </>
      )}
      {(() => {
        const head = state.approvalRequests[0];
        if (!head) return null;
        return <ApprovalPrompt request={head} onResponse={onApprovalResponse ?? (() => {})} />;
      })()}
      {/* Phase 2.5 (T40): bottom footer — TelemetryFooter + InputBox stacked.
          TelemetryFooter always renders (shows zero-state before first turn).
          InputBox renders only when awaiting_input. */}
      <Box flexDirection="column" marginTop={1} data-testid="telemetry-footer-region">
        <TelemetryFooter
          lastTurnInputTokens={state.lastTurnUsage?.inputTokens ?? 0}
          lastTurnOutputTokens={state.lastTurnUsage?.outputTokens ?? 0}
          lastTurnCostUSD={state.lastTurnCost}
          sessionTotalCostUSD={state.sessionTotalCost}
          {...(state.subagentStatus !== undefined ? { subagent: state.subagentStatus } : {})}
        />
        {/* Phase 21: InputBox with dynamic border colour replaces PromptInput */}
        {state.phase === 'awaiting_input' && (
          <InputBox activeSpore={state.activeSpore} onSubmit={onPromptSubmit ?? (() => {})} />
        )}
      </Box>
    </Box>
  );
}
