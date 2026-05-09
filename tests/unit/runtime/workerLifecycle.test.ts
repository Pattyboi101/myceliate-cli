// tests/unit/runtime/workerLifecycle.test.ts
import * as fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process');
vi.mock('node:fs');

import * as childProcess from 'node:child_process';
import * as connection from '../../../src/queue/connection.js';
import { RedisUnavailableError, WorkerCrashedError } from '../../../src/runtime/workerLifecycle.js';

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  flush: vi.fn(),
} as unknown as import('../../../src/util/logger.js').Logger;

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

describe('workerLifecycle — Redis pre-flight', () => {
  beforeEach(() => {
    vi.spyOn(childProcess, 'spawn').mockReturnValue({
      stdout: { resume: vi.fn(), pipe: vi.fn() } as never,
      stderr: { resume: vi.fn(), pipe: vi.fn() } as never,
      on: vi.fn(),
      once: vi.fn(),
      kill: vi.fn(),
      exitCode: null,
    } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws RedisUnavailableError when ping fails', async () => {
    const cause = new Error('ECONNREFUSED');
    vi.spyOn(connection, 'getRedis').mockReturnValue({
      ping: vi.fn().mockRejectedValue(cause),
    } as never);

    const { startWorker } = await import('../../../src/runtime/workerLifecycle.js');
    await expect(
      startWorker({
        redisUrl: 'redis://localhost:6379',
        logger: mockLogger,
        logsDir: '/tmp/test-logs',
      }),
    ).rejects.toThrow(/Redis is required for bash execution/);
  });

  it('proceeds to spawn when ping succeeds', async () => {
    vi.spyOn(connection, 'getRedis').mockReturnValue({
      ping: vi.fn().mockResolvedValue('PONG'),
    } as never);

    const { startWorker } = await import('../../../src/runtime/workerLifecycle.js');
    const handle = await startWorker({
      redisUrl: 'redis://localhost:6379',
      logger: mockLogger,
      logsDir: '/tmp/test-logs',
    });
    expect(handle.child).toBeDefined();
    expect(childProcess.spawn).toHaveBeenCalledWith('pnpm', ['queue:worker'], expect.any(Object));
  });

  it('injects REDIS_URL into spawned child env', async () => {
    vi.spyOn(connection, 'getRedis').mockReturnValue({
      ping: vi.fn().mockResolvedValue('PONG'),
    } as never);

    const { startWorker } = await import('../../../src/runtime/workerLifecycle.js');
    await startWorker({
      redisUrl: 'redis://my-test-instance:6380',
      logger: mockLogger,
      logsDir: '/tmp/test-logs',
    });

    expect(childProcess.spawn).toHaveBeenCalledWith(
      'pnpm',
      ['queue:worker'],
      expect.objectContaining({
        env: expect.objectContaining({ REDIS_URL: 'redis://my-test-instance:6380' }),
      }),
    );
  });
});

describe('workerLifecycle — stdio routing', () => {
  beforeEach(() => {
    vi.spyOn(connection, 'getRedis').mockReturnValue({
      ping: vi.fn().mockResolvedValue('PONG'),
    } as never);
  });

  it('pipes child stdout/stderr to worker.log append stream', async () => {
    const stdoutPipe = vi.fn();
    const stderrPipe = vi.fn();
    vi.spyOn(childProcess, 'spawn').mockReturnValue({
      stdout: { pipe: stdoutPipe, resume: vi.fn() } as never,
      stderr: { pipe: stderrPipe, resume: vi.fn() } as never,
      on: vi.fn(),
      once: vi.fn(),
      kill: vi.fn(),
      exitCode: null,
    } as never);

    const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
    const fakeStream = { write: vi.fn(), end: vi.fn() };
    const createSpy = vi.spyOn(fs, 'createWriteStream').mockReturnValue(fakeStream as never);

    const { startWorker } = await import('../../../src/runtime/workerLifecycle.js');
    await startWorker({
      redisUrl: 'redis://localhost:6379',
      logger: mockLogger,
      logsDir: '/tmp/test-logs',
    });

    expect(mkdirSpy).toHaveBeenCalledWith('/tmp/test-logs', { recursive: true });
    expect(createSpy).toHaveBeenCalledWith('/tmp/test-logs/worker.log', { flags: 'a' });
    expect(stdoutPipe).toHaveBeenCalledWith(fakeStream);
    expect(stderrPipe).toHaveBeenCalledWith(fakeStream);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
});

describe('workerLifecycle — pending jobs Map', () => {
  beforeEach(() => {
    vi.spyOn(connection, 'getRedis').mockReturnValue({
      ping: vi.fn().mockResolvedValue('PONG'),
    } as never);
    vi.spyOn(childProcess, 'spawn').mockReturnValue({
      stdout: { pipe: vi.fn() } as never,
      stderr: { pipe: vi.fn() } as never,
      on: vi.fn(),
      once: vi.fn(),
      kill: vi.fn(),
      exitCode: null,
    } as never);
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
    vi.spyOn(fs, 'createWriteStream').mockReturnValue({ end: vi.fn() } as never);
  });

  it('trackJob + releaseJob cycle does not throw', async () => {
    const { startWorker } = await import('../../../src/runtime/workerLifecycle.js');
    const handle = await startWorker({
      redisUrl: 'redis://localhost:6379',
      logger: mockLogger,
      logsDir: '/tmp/test-logs',
    });
    const reject = vi.fn();
    expect(() => handle.trackJob('job-1', reject)).not.toThrow();
    expect(() => handle.releaseJob('job-1')).not.toThrow();
  });

  it('releaseJob on unknown jobId is a no-op (does not throw)', async () => {
    const { startWorker } = await import('../../../src/runtime/workerLifecycle.js');
    const handle = await startWorker({
      redisUrl: 'redis://localhost:6379',
      logger: mockLogger,
      logsDir: '/tmp/test-logs',
    });
    expect(() => handle.releaseJob('never-tracked')).not.toThrow();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
});

describe('workerLifecycle — crash detection', () => {
  beforeEach(() => {
    vi.spyOn(connection, 'getRedis').mockReturnValue({
      ping: vi.fn().mockResolvedValue('PONG'),
    } as never);
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
    vi.spyOn(fs, 'createWriteStream').mockReturnValue({ end: vi.fn() } as never);
  });

  it('rejects all tracked jobs on non-clean exit', async () => {
    let exitHandler!: (code: number | null, signal: NodeJS.Signals | null) => void;
    vi.spyOn(childProcess, 'spawn').mockReturnValue({
      stdout: { pipe: vi.fn() } as never,
      stderr: { pipe: vi.fn() } as never,
      on: vi.fn((event, handler) => {
        if (event === 'exit') exitHandler = handler;
      }),
      once: vi.fn(),
      kill: vi.fn(),
      exitCode: null,
    } as never);

    const { startWorker, WorkerCrashedError } = await import(
      '../../../src/runtime/workerLifecycle.js'
    );
    const handle = await startWorker({
      redisUrl: 'redis://localhost:6379',
      logger: mockLogger,
      logsDir: '/tmp/test-logs',
    });

    const reject1 = vi.fn();
    const reject2 = vi.fn();
    handle.trackJob('job-1', reject1);
    handle.trackJob('job-2', reject2);

    // Simulate worker crash
    exitHandler(1, null);

    expect(reject1).toHaveBeenCalledWith(expect.any(WorkerCrashedError));
    expect(reject2).toHaveBeenCalledWith(expect.any(WorkerCrashedError));
    expect(reject1.mock.calls[0]![0].exitCode).toBe(1);
  });

  it('does NOT reject tracked jobs on clean shutdown exit', async () => {
    let exitHandler!: (code: number | null, signal: NodeJS.Signals | null) => void;
    vi.spyOn(childProcess, 'spawn').mockReturnValue({
      stdout: { pipe: vi.fn() } as never,
      stderr: { pipe: vi.fn() } as never,
      on: vi.fn((event, handler) => {
        if (event === 'exit') exitHandler = handler;
      }),
      once: vi.fn((event, handler) => {
        if (event === 'exit') {
          // simulate immediate exit on shutdown
          setTimeout(() => handler(0, 'SIGTERM'), 0);
        }
      }),
      kill: vi.fn(),
      exitCode: null,
    } as never);

    const { startWorker } = await import('../../../src/runtime/workerLifecycle.js');
    const handle = await startWorker({
      redisUrl: 'redis://localhost:6379',
      logger: mockLogger,
      logsDir: '/tmp/test-logs',
    });

    const reject = vi.fn();
    handle.trackJob('job-1', reject);

    await handle.shutdown();
    // Now simulate the actual exit event the kernel would deliver
    exitHandler(0, 'SIGTERM');

    expect(reject).not.toHaveBeenCalled();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
});
