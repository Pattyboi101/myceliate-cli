import { describe, expect, it } from 'vitest';
import type { Message } from '../../../src/adapters/messages.js';
import {
  CAVEMAN_SYSTEM_PREFIX,
  applyCavemanPrefix,
  defaultCavemanState,
  isCavemanEnabledByEnv,
} from '../../../src/runtime/cavemanMode.js';

describe('isCavemanEnabledByEnv', () => {
  it('returns true for truthy values: 1, true, on, yes (case-insensitive)', () => {
    for (const v of ['1', 'true', 'TRUE', 'on', 'ON', 'yes', 'YES']) {
      expect(isCavemanEnabledByEnv({ MYCELIATE_CAVEMAN: v })).toBe(true);
    }
  });

  it('returns false for falsy values and undefined', () => {
    for (const v of ['0', 'false', 'off', 'no', '', undefined]) {
      const env = v === undefined ? {} : { MYCELIATE_CAVEMAN: v };
      expect(isCavemanEnabledByEnv(env)).toBe(false);
    }
  });
});

describe('defaultCavemanState', () => {
  it('respects MYCELIATE_CAVEMAN env at boot', () => {
    expect(defaultCavemanState({ MYCELIATE_CAVEMAN: '1' })).toEqual({ active: true });
    expect(defaultCavemanState({})).toEqual({ active: false });
  });
});

describe('CAVEMAN_SYSTEM_PREFIX', () => {
  it('contains the key terseness instructions', () => {
    expect(CAVEMAN_SYSTEM_PREFIX).toContain('caveman');
    expect(CAVEMAN_SYSTEM_PREFIX.toLowerCase()).toContain('no article');
    expect(CAVEMAN_SYSTEM_PREFIX.toLowerCase()).toContain('no pleasantr');
    expect(CAVEMAN_SYSTEM_PREFIX.toLowerCase()).toContain('code block');
  });

  it('is non-trivial length', () => {
    expect(CAVEMAN_SYSTEM_PREFIX.length).toBeGreaterThan(200);
    expect(CAVEMAN_SYSTEM_PREFIX.length).toBeLessThan(2000);
  });
});

describe('applyCavemanPrefix', () => {
  const baseMessages: Message[] = [
    { role: 'system', content: 'You are myceliate.' },
    { role: 'user', content: 'hi' },
  ];

  it('returns input unchanged when state.active is false', () => {
    const result = applyCavemanPrefix(baseMessages, { active: false });
    expect(result).toEqual(baseMessages);
    expect(result).not.toBe(baseMessages); // returns a defensive copy
  });

  it('prepends caveman system message when state.active is true', () => {
    const result = applyCavemanPrefix(baseMessages, { active: true });
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ role: 'system', content: CAVEMAN_SYSTEM_PREFIX });
    expect(result[1]).toEqual(baseMessages[0]);
    expect(result[2]).toEqual(baseMessages[1]);
  });

  it('does not mutate the input array', () => {
    const input = [...baseMessages];
    applyCavemanPrefix(input, { active: true });
    expect(input).toEqual(baseMessages);
  });

  it('is idempotent — re-applying does not double-prepend', () => {
    const once = applyCavemanPrefix(baseMessages, { active: true });
    const twice = applyCavemanPrefix(once, { active: true });
    expect(twice).toEqual(once);
  });
});
