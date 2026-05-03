// tests/unit/tools/bash.test.ts
import { describe, expect, it, vi } from 'vitest';
import { HitlGate } from '../../../src/security/hitlGate.js';
import { createBashTool } from '../../../src/tools/bash.js';

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
      defaultTimeoutMs: 1000,
    });
    const out = await tool.run(
      { command: 'echo ok' },
      { cwd: '/tmp', abort: new AbortController().signal },
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
      defaultTimeoutMs: 1000,
    });
    await expect(
      tool.run({ command: 'rm -rf /' }, { cwd: '/tmp', abort: new AbortController().signal }),
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
      defaultTimeoutMs: 1000,
    });
    await tool.run(
      { command: 'sudo apt update' },
      { cwd: '/tmp', abort: new AbortController().signal },
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
      defaultTimeoutMs: 1000,
    });
    await expect(
      tool.run({ command: 'echo ok' }, { cwd: '/tmp', abort: new AbortController().signal }),
    ).rejects.toThrow(/worker exploded/);
    expect(queue.add).toHaveBeenCalledOnce();
  });
});
