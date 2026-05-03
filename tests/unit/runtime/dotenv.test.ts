// tests/unit/runtime/dotenv.test.ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('dotenv loading', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'myc-env-'));
    Reflect.deleteProperty(process.env, 'MYC_TEST_VAR');
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
    Reflect.deleteProperty(process.env, 'MYC_TEST_VAR');
  });

  it('loads MYC_TEST_VAR from .env when not already in process.env', async () => {
    await writeFile(join(tmp, '.env'), 'MYC_TEST_VAR=from_env_file\n', 'utf8');
    const { loadDotenv } = await import('../../../src/runtime/dotenv.js');
    loadDotenv(tmp);
    expect(process.env.MYC_TEST_VAR).toBe('from_env_file');
  });

  it('does NOT overwrite values already present in process.env', async () => {
    process.env.MYC_TEST_VAR = 'from_shell';
    await writeFile(join(tmp, '.env'), 'MYC_TEST_VAR=from_env_file\n', 'utf8');
    const { loadDotenv } = await import('../../../src/runtime/dotenv.js');
    loadDotenv(tmp);
    expect(process.env.MYC_TEST_VAR).toBe('from_shell');
  });

  it('does not throw when .env is absent', async () => {
    const { loadDotenv } = await import('../../../src/runtime/dotenv.js');
    expect(() => loadDotenv(tmp)).not.toThrow();
  });
});
