export type Usage = {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cacheHitTokens?: number;
};

export type StreamEvent =
  | { type: 'reasoning_delta'; text: string }
  | { type: 'content_delta'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | { type: 'done'; usage: Usage }
  | { type: 'error'; cause: Error };

export const isReasoningDelta = (
  e: StreamEvent,
): e is Extract<StreamEvent, { type: 'reasoning_delta' }> => e.type === 'reasoning_delta';
export const isContentDelta = (
  e: StreamEvent,
): e is Extract<StreamEvent, { type: 'content_delta' }> => e.type === 'content_delta';
export const isToolCall = (e: StreamEvent): e is Extract<StreamEvent, { type: 'tool_call' }> =>
  e.type === 'tool_call';
export const isDone = (e: StreamEvent): e is Extract<StreamEvent, { type: 'done' }> =>
  e.type === 'done';
export const isError = (e: StreamEvent): e is Extract<StreamEvent, { type: 'error' }> =>
  e.type === 'error';
