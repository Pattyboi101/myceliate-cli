import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// tests/unit/util/logger.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '../../../src/util/logger.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'myc-log-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('createLogger', () => {
  it('writes structured JSON lines to a file under .myceliate/logs/', async () => {
    const log = createLogger({ logsDir: join(dir, 'logs') });
    log.info({ event: 'hello', x: 1 });
    log.warn({ event: 'careful' });
    await log.flush();
    const file = await readFile(join(dir, 'logs', 'session.log'), 'utf8');
    const lines = file
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ level: 'info', event: 'hello', x: 1 });
    expect(lines[1]).toMatchObject({ level: 'warn', event: 'careful' });
  });

  it('does not poison the chain when an I/O failure occurs', async () => {
    // mkdir under a path that already exists as a regular file → ENOTDIR.
    const blocker = join(dir, 'blocker');
    await writeFile(blocker, '');
    const log = createLogger({ logsDir: join(blocker, 'sub') });
    log.info({ event: 'first-batch-will-be-dropped' });
    await expect(log.flush()).resolves.toBeUndefined();
    log.info({ event: 'second-batch-also-dropped' });
    await expect(log.flush()).resolves.toBeUndefined();
  });

  it('survives circular-reference entries without throwing', () => {
    const log = createLogger({ logsDir: join(dir, 'logs') });
    const circular: Record<string, unknown> = { event: 'circ' };
    circular.self = circular;
    expect(() => log.info(circular)).not.toThrow();
  });

  it('emits a [unserializable] placeholder for circular-reference entries', async () => {
    const log = createLogger({ logsDir: join(dir, 'logs') });
    const circular: Record<string, unknown> = { event: 'circ' };
    circular.self = circular;
    log.info(circular);
    await log.flush();
    const file = await readFile(join(dir, 'logs', 'session.log'), 'utf8');
    const lines = file
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'info', msg: '[unserializable]' });
  });

  it('sanitises opts.file via basename() to prevent path traversal', async () => {
    const log = createLogger({ logsDir: join(dir, 'logs'), file: '../escape.log' });
    log.info({ event: 'safe' });
    await log.flush();
    const file = await readFile(join(dir, 'logs', 'escape.log'), 'utf8');
    expect(file).toContain('safe');
  });
});
