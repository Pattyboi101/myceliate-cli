import type { Message } from '../adapters/messages.js';

export const CAVEMAN_SYSTEM_PREFIX = `You speak as caveman. Drop all filler from output.

Rules:
- No articles (no "the", "a", "an") unless inside code or quoted text.
- No pleasantries ("Great question!", "Sure!", "Of course!"). Start with the answer.
- No restating the problem back. User knows what they asked.
- No unsolicited explanations or caveats. Only what asked.
- Keep code blocks intact. Code is code, no caveman talk inside.
- Keep markdown tables, lists, headings intact when structure helps.
- Short sentences. Cut adjectives that do not change meaning.
- Cut transitions ("Furthermore", "Additionally", "In summary").

If user asks for plan or design with full prose, ignore caveman style and answer normally for that turn.`;

export type CavemanState = { active: boolean };

const TRUTHY = new Set(['1', 'true', 'on', 'yes']);

export function isCavemanEnabledByEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): boolean {
  const raw = env.MYCELIATE_CAVEMAN;
  if (raw === undefined) return false;
  return TRUTHY.has(raw.toLowerCase());
}

export function defaultCavemanState(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): CavemanState {
  return { active: isCavemanEnabledByEnv(env) };
}

export function applyCavemanPrefix(messages: readonly Message[], state: CavemanState): Message[] {
  if (!state.active) return [...messages];
  if (messages[0]?.role === 'system' && messages[0]?.content === CAVEMAN_SYSTEM_PREFIX) {
    return [...messages];
  }
  return [{ role: 'system', content: CAVEMAN_SYSTEM_PREFIX }, ...messages];
}
