// src/ui/onboarding.ts
import { cancel, intro, isCancel, outro, password, select } from '@clack/prompts';

export type OnboardingResult = {
  apiKey: string;
  adapter: 'v3' | 'v4';
  model: string;
};

/**
 * Masked variant of the secret prompt. Used for the API key so keystrokes
 * don't echo to the terminal and survive in scrollback / tmux / ssh recordings.
 */
async function promptPassword(opts: Parameters<typeof password>[0]): Promise<string> {
  const result = await password(opts);
  if (isCancel(result)) {
    cancel('Aborted.');
    process.exit(0);
  }
  return result;
}

async function promptSelect<T extends string>(opts: {
  message: string;
  options: Array<{ value: T; label: string }>;
}): Promise<T> {
  const result = await select(opts);
  if (isCancel(result)) {
    cancel('Aborted.');
    process.exit(0);
  }
  return result as T;
}

/**
 * Pre-Ink onboarding via Clack. Collects only credentials/configuration —
 * the initial user prompt now arrives via Ink's <PromptInput> after the
 * banner mounts (Phase 12.5: chat-style start, no Clack interrupt before
 * the TUI).
 */
export async function runOnboarding(defaults: {
  apiKey?: string;
  adapter?: 'v3' | 'v4';
  model?: string;
}): Promise<OnboardingResult> {
  intro('myceliate-cli — autonomous DeepSeek agent');

  const apiKey =
    defaults.apiKey ??
    (await promptPassword({
      message: 'DeepSeek API key',
      validate: (v) => (v.length < 20 ? 'API key looks too short' : undefined),
    }));

  const adapter =
    defaults.adapter ??
    (await promptSelect<'v3' | 'v4'>({
      message: 'Adapter',
      options: [
        { value: 'v3', label: 'v3 — DeepSeek Reasoner (works today)' },
        { value: 'v4', label: 'v4 — DeepSeek V4 (DSML, when available)' },
      ],
    }));

  const model = defaults.model ?? (adapter === 'v3' ? 'deepseek-reasoner' : 'deepseek-v4-pro');

  outro('Launching agent…');
  return { apiKey, adapter, model };
}
