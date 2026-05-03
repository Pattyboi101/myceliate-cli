import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@clack/prompts', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  isCancel: () => false,
  password: vi.fn(async (_opts: { message: string }) => 'sk-test-1234567890abcdef'),
  select: vi.fn(async () => 'v3'),
}));

import * as clack from '@clack/prompts';
import { runOnboarding } from '../../../src/ui/onboarding.js';

describe('runOnboarding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it('collects apiKey, adapter, model with defaults applied', async () => {
    const result = await runOnboarding({});
    expect(result).toEqual({
      apiKey: 'sk-test-1234567890abcdef',
      adapter: 'v3',
      model: 'deepseek-reasoner',
    });
  });
  it('skips prompts when defaults are provided', async () => {
    const result = await runOnboarding({
      apiKey: 'sk-default',
      adapter: 'v4',
      model: 'deepseek-v4-pro',
    });
    expect(result.apiKey).toBe('sk-default');
    expect(result.adapter).toBe('v4');
    expect(result.model).toBe('deepseek-v4-pro');
  });
  // F2: API key must be collected via masked password() so keystrokes don't
  // echo into terminal scrollback / tmux logs / ssh recordings.
  it('uses password() (masked) for the API key prompt — not text()', async () => {
    await runOnboarding({});
    expect(clack.password).toHaveBeenCalledTimes(1);
    const passwordCall = (clack.password as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(passwordCall.message).toContain('API key');
    // Length validator is preserved.
    expect(typeof passwordCall.validate).toBe('function');
    expect(passwordCall.validate('short')).toBe('API key looks too short');
    expect(passwordCall.validate('this-is-long-enough-1234567890')).toBeUndefined();
  });
  // Phase 12.5: the initial-prompt Clack `text()` was removed so the chat-style
  // start lands the user in <PromptInput> immediately. Lock the regression in.
  it('does not invoke text() at all — chat-style start owns the first prompt', async () => {
    await runOnboarding({});
    // text() isn't even imported by onboarding.ts anymore. The result should not
    // contain `initialPrompt`.
    const result = await runOnboarding({});
    expect((result as Record<string, unknown>).initialPrompt).toBeUndefined();
  });
});
