// tests/unit/runtime/workerLifecycle.test.ts
import { describe, expect, it } from 'vitest';
import {
  RedisUnavailableError,
  WorkerCrashedError,
} from '../../../src/runtime/workerLifecycle.js';

describe('workerLifecycle — error classes', () => {
  it('RedisUnavailableError carries the canonical diagnostic message', () => {
    const err = new RedisUnavailableError();
    expect(err.name).toBe('RedisUnavailableError');
    expect(err.message).toContain('Redis is required for bash execution');
    expect(err.message).toContain('docker compose up -d redis');
  });

  it('RedisUnavailableError preserves cause', () => {
    const cause = new Error('ECONNREFUSED');
    const err = new RedisUnavailableError(cause);
    expect(err.cause).toBe(cause);
  });

  it('WorkerCrashedError carries exitCode + signal', () => {
    const err = new WorkerCrashedError(1, null);
    expect(err.name).toBe('WorkerCrashedError');
    expect(err.exitCode).toBe(1);
    expect(err.signal).toBeNull();
    expect(err.message).toContain('code=1');
  });
});
