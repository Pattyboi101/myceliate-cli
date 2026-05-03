// tests/unit/util/logger.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../../../src/util/logger.js';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'myc-log-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('createLogger', () => {
  it('writes structured JSON lines to a file under .myceliate/logs/', async () => {
    const log = createLogger({ logsDir: join(dir, 'logs') });
    log.info({ event: 'hello', x: 1 });
    log.warn({ event: 'careful' });
    await log.flush();
    const file = await readFile(join(dir, 'logs', 'session.log'), 'utf8');
    const lines = file.trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ level: 'info', event: 'hello', x: 1 });
    expect(lines[1]).toMatchObject({ level: 'warn', event: 'careful' });
  });
});
