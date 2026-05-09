// tests/unit/tools/bash.test.ts
import { describe, expect, it, vi } from 'vitest';
import { WorkerCrashedError } from '../../../src/runtime/workerLifecycle.js';
import type { BashToolDeps } from '../../../src/tools/bash.js';
import { createBashTool } from '../../../src/tools/bash.js';
import { HitlGate } from '../../../src/security/hitlGate.js';

const stubWorker: BashToolDeps['worker'] = {
  child: {} as never,
  trackJob: () => {},
  releaseJob: () => {},
  shutdown: async () => {},
};

describe('bashTool', () => {
  function fakeQueue(behaviour: 'success' | 'fail') {
    return {
      add: vi.fn(async () => ({
        waitUntilFinished: async () =>
          behaviour === 'success'
            ? { exitCode: 0, stdout: 'ok\n', stderr: '', truncated: false, timedOut: false }
            : Promise.reject(new Error('worker exploded')),
      })),
    };
  }

  it('runs HITL check, dispatches to queue on safe command, returns formatted output', async () => {
    const hitl = new HitlGate({ requestApproval: vi.fn() });
    const queue = fakeQueue('success');
    const tool = createBashTool({
      hitl,
      queue: queue as never,
      queueEvents: {} as never,
      worker: stubWorker,
      defaultTimeoutMs: 1000,
    });
    const out = await tool.run(
      { command: 'echo ok' },
      { cwd: '/tmp', abort: new AbortController().signal, toolUseId: 'test-call-id' },
    );
    expect(out).toContain('exitCode: 0');
    expect(out).toContain('ok');
    expect(queue.add).toHaveBeenCalledOnce();
  });

  it('throws with HITL feedback when the command is dangerous and the user rejects', async () => {
    const hitl = new HitlGate({
      requestApproval: async () => ({ decision: 'reject', feedback: 'no thanks' }),
    });
    const queue = fakeQueue('success');
    const tool = createBashTool({
      hitl,
      queue: queue as never,
      queueEvents: {} as never,
      worker: stubWorker,
      defaultTimeoutMs: 1000,
    });
    await expect(
      tool.run(
        { command: 'rm -rf /' },
        { cwd: '/tmp', abort: new AbortController().signal, toolUseId: 'test-call-id' },
      ),
    ).rejects.toThrow(/no thanks/);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('dispatches when HITL approves a dangerous command', async () => {
    const hitl = new HitlGate({
      requestApproval: async () => ({ decision: 'approve' }),
    });
    const queue = fakeQueue('success');
    const tool = createBashTool({
      hitl,
      queue: queue as never,
      queueEvents: {} as never,
      worker: stubWorker,
      defaultTimeoutMs: 1000,
    });
    await tool.run(
      { command: 'sudo apt update' },
      { cwd: '/tmp', abort: new AbortController().signal, toolUseId: 'test-call-id' },
    );
    expect(queue.add).toHaveBeenCalledOnce();
  });

  // Phase 14 review m6 fix: the `fakeQueue('fail')` variant existed but was
  // unused. Locks the queue/worker-explosion path so the bash tool's rejection
  // bubbles up to runReactLoop's catch and yields tool_result.status='failed'
  // (NOT 'rejected' — only HITL-prefixed throws map to rejected per Task 92).
  it('rethrows when waitUntilFinished rejects (worker exploded)', async () => {
    const hitl = new HitlGate({ requestApproval: vi.fn() });
    const queue = fakeQueue('fail');
    const tool = createBashTool({
      hitl,
      queue: queue as never,
      queueEvents: {} as never,
      worker: stubWorker,
      defaultTimeoutMs: 1000,
    });
    await expect(
      tool.run(
        { command: 'echo ok' },
        { cwd: '/tmp', abort: new AbortController().signal, toolUseId: 'test-call-id' },
      ),
    ).rejects.toThrow(/worker exploded/);
    expect(queue.add).toHaveBeenCalledOnce();
  });
});

describe('bash tool — worker crash detection', () => {
  it('rejects with WorkerCrashedError when the worker crashes mid-dispatch', async () => {
    let registeredReject!: (err: Error) => void;
    const trackJob = vi.fn((_: string, reject: (err: Error) => void) => {
      registeredReject = reject;
    });
    const releaseJob = vi.fn();

    const fakeJob = {
      waitUntilFinished: vi.fn(() => new Promise(() => {/* never resolves */})),
    };

    const deps: BashToolDeps = {
      hitl: { checkBash: async () => ({ allowed: true }) } as never,
      queue: { add: vi.fn().mockResolvedValue(fakeJob) } as never,
      queueEvents: {} as never,
      worker: {
        child: {} as never,
        trackJob,
        releaseJob,
        shutdown: async () => {},
      },
      defaultTimeoutMs: 30_000,
    };

    const tool = createBashTool(deps);
    const dispatchPromise = tool.run(
      { command: 'echo hi', cwd: '', timeoutMs: 0 },
      { cwd: '/tmp', toolUseId: 'test-id' } as never,
    );

    // Simulate worker crash by invoking the registered rejecter
    setTimeout(() => registeredReject(new WorkerCrashedError(1, null)), 5);

    await expect(dispatchPromise).rejects.toThrow(WorkerCrashedError);
    expect(releaseJob).toHaveBeenCalledWith(expect.any(String));
  });
});
