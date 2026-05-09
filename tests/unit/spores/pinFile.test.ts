// tests/unit/spores/pinFile.test.ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PIN_FILENAME, clearPin, readPin, writePin } from '../../../src/spores/pinFile.js';
import type { Logger } from '../../../src/util/logger.js';

function fakeLogger(): { logger: Logger; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  const noop = (_e: Record<string, unknown>): void => {};
  const warn = (e: Record<string, unknown>): void => {
    calls.push(e);
  };
  return {
    logger: { debug: noop, info: noop, warn, error: noop, flush: async () => {} },
    calls,
  };
}

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  flush: async () => {},
};

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'spore-pin-'));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('pin file IO', () => {
  it('returns null when pin file does not exist', async () => {
    const pin = await readPin(tmp, noopLogger);
    expect(pin).toBeNull();
  });

  it('writes and reads a pin', async () => {
    await writePin(tmp, 'solo-business', noopLogger);
    const pin = await readPin(tmp, noopLogger);
    expect(pin).toBe('solo-business');
  });

  it('clears a pin', async () => {
    await writePin(tmp, 'research', noopLogger);
    await clearPin(tmp, noopLogger);
    expect(await readPin(tmp, noopLogger)).toBeNull();
  });

  it('rejects invalid pin content (whitespace, non-kebab)', async () => {
    const pinPath = join(tmp, PIN_FILENAME);
    await mkdir(dirname(pinPath), { recursive: true });
    await writeFile(pinPath, '  Not Kebab Case\n', 'utf8');
    expect(await readPin(tmp, noopLogger)).toBeNull();
  });
});

describe('pinFile Logger DI', () => {
  it('emits warn event when pin file contains invalid name', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'myc-pin-'));
    try {
      await mkdir(join(cwd, '.myceliate'), { recursive: true });
      await writeFile(join(cwd, '.myceliate', 'sector.txt'), 'INVALID NAME!\n', 'utf8');
      const { logger, calls } = fakeLogger();
      const result = await readPin(cwd, logger);
      expect(result).toBeNull();
      expect(calls.some((c) => c.event === 'pin_invalid_name' && c.name === 'INVALID NAME!')).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
