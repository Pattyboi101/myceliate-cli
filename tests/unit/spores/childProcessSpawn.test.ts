// tests/unit/spores/childProcessSpawn.test.ts
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { childProcessSpawn } from '../../../src/spores/childProcessSpawn.js';

const FIXTURES = resolve(__dirname, '../../fixtures/subagent-runners');

const DUMMY_REQ = {
  persona_name: 'test',
  persona_skill: 'You are a test persona.',
  task: 'do nothing',
};

describe('childProcessSpawn failure paths', () => {
  it('spawn ENOENT: returns spawn failed error when executable does not exist', async () => {
    // Passing a non-existent execPath triggers the child_process error event (ENOENT).
    const result = await childProcessSpawn(
      DUMMY_REQ,
      5_000,
      `${FIXTURES}/crashes.js`,
      '/does/not/exist/node',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/spawn failed/);
    }
  });

  it('timeout: returns sub-agent timeout when child hangs past timeoutMs', async () => {
    const result = await childProcessSpawn(DUMMY_REQ, 200, `${FIXTURES}/hangs.js`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/timeout/);
    }
  }, 5_000);

  it('crash: returns exit-code error when child exits non-zero', async () => {
    const result = await childProcessSpawn(DUMMY_REQ, 5_000, `${FIXTURES}/crashes.js`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/sub-agent exit 1/);
    }
  });

  it('invalid JSON: returns parse error when child writes non-JSON', async () => {
    const result = await childProcessSpawn(DUMMY_REQ, 5_000, `${FIXTURES}/garbage.js`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/invalid sub-agent response/);
    }
  });

  it('wrong shape: Zod rejects a well-formed JSON object with the wrong keys', async () => {
    const result = await childProcessSpawn(DUMMY_REQ, 5_000, `${FIXTURES}/bogus-shape.js`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/invalid sub-agent response/);
    }
  });
});
