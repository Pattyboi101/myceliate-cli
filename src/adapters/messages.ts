export type ToolCall = {
  id: string;
  name: string;
  args: unknown;
};

export type ToolResult = {
  tool_use_id: string;
  command: string; // For R10 layer 3: preserved during micro-compaction.
  is_error: boolean;
  content: string; // Cleared by micro-compaction; metadata above is kept.
};

export type SystemMessage = { role: 'system'; content: string };
export type UserMessage = { role: 'user'; content: string };
/**
 * Assistant turn. `content` may be `null` when the turn is purely a tool call
 * (matches OpenAI / DeepSeek wire convention; V4 may also emit reasoning-only turns).
 */
export type AssistantMessage = {
  role: 'assistant';
  content: string | null;
  reasoning_content?: string;
  tool_calls?: ToolCall[];
};
export type ToolResultMessage = { role: 'tool'; result: ToolResult };

export type Message = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;

export const hasToolCalls = (m: Message): m is AssistantMessage & { tool_calls: ToolCall[] } =>
  m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0;

export const hasReasoningContent = (
  m: Message,
): m is AssistantMessage & { reasoning_content: string } =>
  m.role === 'assistant' &&
  typeof m.reasoning_content === 'string' &&
  m.reasoning_content.length > 0;
