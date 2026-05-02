import type { Message } from './messages.js';
import type { StreamEvent } from './streamEvent.js';

export type ToolDefinition = {
  name: string;
  description: string;
  /** JSON Schema with `additionalProperties: false` and every prop in `required` (R3). */
  parameters: object;
};

export type ChatRequest = {
  model: string;
  messages: Message[];
  tools?: readonly ToolDefinition[];
  thinking: boolean; // V4 Thinking Mode toggle.
  strict: boolean; // R3: enforce strict schema validation server-side.
  signal?: AbortSignal;
  /** Implementation-specific extras (sampling params etc.) — kept opaque. */
  options?: Readonly<Record<string, unknown>>;
};

export interface DeepSeekClient {
  /**
   * Streams canonical events. Adapters own their wire format end-to-end (R1):
   * the V3 adapter parses JSON tool_calls, the V4 adapter parses DSML markers.
   * Callers consume only StreamEvent.
   */
  stream(req: ChatRequest): AsyncIterable<StreamEvent>;

  /** Adapter identifier for logging / telemetry. */
  readonly id: 'v3' | 'v4';
}
