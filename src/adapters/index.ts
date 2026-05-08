import type { DeepSeekClient } from './DeepSeekClient.js';
import { V3Adapter } from './v3/adapter.js';
import { V4Adapter } from './v4/adapter.js';

/**
 * Factory for sub-agent use: reads DEEPSEEK_API_KEY + DEEPSEEK_ADAPTER + DEEPSEEK_BASE_URL
 * from the process environment. The sub-agent runner uses this to create its own client
 * without importing the full orchestrator boot sequence.
 */
export function createDeepSeekClient(): DeepSeekClient {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY is required for sub-agent runner');
  const baseUrl = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com';
  const adapter = process.env.DEEPSEEK_ADAPTER;
  if (adapter === 'v4') return new V4Adapter({ apiKey, baseUrl });
  return new V3Adapter({ apiKey, baseUrl });
}
