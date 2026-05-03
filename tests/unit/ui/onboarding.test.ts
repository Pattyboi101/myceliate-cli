import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@clack/prompts', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  isCancel: () => false,
  text: vi.fn(async (opts: { message: string }) => {
    if (opts.message.includes('API key')) return 'sk-test-1234567890abcdef';
    if (opts.message.includes('agent to do')) return 'do thing';
    return 'fallback';
  }),
  select: vi.fn(async () => 'v3'),
}));

import { runOnboarding } from '../../../src/ui/onboarding.js';

describe('runOnboarding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it('collects apiKey, adapter, model, initialPrompt with defaults applied', async () => {
    const result = await runOnboarding({});
    expect(result).toEqual({
      apiKey: 'sk-test-1234567890abcdef',
      adapter: 'v3',
      model: 'deepseek-reasoner',
      initialPrompt: 'do thing',
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
});
