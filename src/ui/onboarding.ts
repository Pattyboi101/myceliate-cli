// src/ui/onboarding.ts
import { cancel, intro, isCancel, outro, select, text } from '@clack/prompts';

export type OnboardingResult = {
  apiKey: string;
  adapter: 'v3' | 'v4';
  model: string;
  initialPrompt: string;
};

async function promptText(opts: Parameters<typeof text>[0]): Promise<string> {
  const result = await text(opts);
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

export async function runOnboarding(defaults: {
  apiKey?: string;
  adapter?: 'v3' | 'v4';
  model?: string;
}): Promise<OnboardingResult> {
  intro('myceliate-cli — autonomous DeepSeek agent');

  const apiKey =
    defaults.apiKey ??
    (await promptText({
      message: 'DeepSeek API key',
      placeholder: 'sk-...',
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

  const initialPrompt = await promptText({ message: 'What would you like the agent to do?' });

  outro('Starting agent…');
  return { apiKey, adapter, model, initialPrompt };
}
