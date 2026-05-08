// tests/unit/spores/pinFile.test.ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PIN_FILENAME, clearPin, readPin, writePin } from '../../../src/spores/pinFile.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'spore-pin-'));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('pin file IO', () => {
  it('returns null when pin file does not exist', async () => {
    const pin = await readPin(tmp);
    expect(pin).toBeNull();
  });

  it('writes and reads a pin', async () => {
    await writePin(tmp, 'solo-business');
    const pin = await readPin(tmp);
    expect(pin).toBe('solo-business');
  });

  it('clears a pin', async () => {
    await writePin(tmp, 'research');
    await clearPin(tmp);
    expect(await readPin(tmp)).toBeNull();
  });

  it('rejects invalid pin content (whitespace, non-kebab)', async () => {
    const pinPath = join(tmp, PIN_FILENAME);
    await mkdir(dirname(pinPath), { recursive: true });
    await writeFile(pinPath, '  Not Kebab Case\n', 'utf8');
    expect(await readPin(tmp)).toBeNull();
  });
});
