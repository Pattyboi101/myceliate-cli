// tests/unit/queue/notifications.test.ts
import { describe, expect, it, vi } from 'vitest';
import {
  type JobFailure,
  type JobOutcome,
  createNotificationBridge,
} from '../../../src/queue/notifications.js';

describe('createNotificationBridge', () => {
  it('forwards completed events to onCompleted with the job result', () => {
    const onCompleted = vi.fn();
    const bridge = createNotificationBridge({ onCompleted, onFailed: vi.fn() });
    const outcome: JobOutcome = {
      jobId: 'j1',
      toolUseId: 't1',
      queueName: 'bash',
      returnValue: { exitCode: 0, stdout: 'ok', stderr: '', truncated: false, timedOut: false },
    };
    bridge.emitCompleted(outcome);
    expect(onCompleted).toHaveBeenCalledWith(outcome);
    expect(onCompleted).toHaveBeenCalledTimes(1);
  });

  it('forwards failed events to onFailed', () => {
    const onFailed = vi.fn();
    const bridge = createNotificationBridge({ onCompleted: vi.fn(), onFailed });
    bridge.emitFailed({ jobId: 'j1', toolUseId: 't1', queueName: 'bash', failedReason: 'oom' });
    expect(onFailed).toHaveBeenCalled();
    expect(onFailed).toHaveBeenCalledTimes(1);
  });

  it('forwards the failedReason verbatim', () => {
    const onFailed = vi.fn();
    const bridge = createNotificationBridge({ onCompleted: vi.fn(), onFailed });
    const failure: JobFailure = {
      jobId: 'j2',
      toolUseId: 't2',
      queueName: 'bash',
      failedReason: 'ECONNREFUSED redis://localhost:6379',
    };
    bridge.emitFailed(failure);
    expect(onFailed).toHaveBeenCalledWith(failure);
  });

  it('emitCompleted passes the full BashJobReturn struct', () => {
    const onCompleted = vi.fn();
    const bridge = createNotificationBridge({ onCompleted, onFailed: vi.fn() });
    const outcome: JobOutcome = {
      jobId: 'j3',
      toolUseId: 't3',
      queueName: 'bash',
      returnValue: {
        exitCode: 1,
        stdout: 'partial output',
        stderr: 'some error',
        truncated: true,
        timedOut: false,
      },
    };
    bridge.emitCompleted(outcome);
    expect(onCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        returnValue: expect.objectContaining({
          exitCode: 1,
          stdout: 'partial output',
          stderr: 'some error',
          truncated: true,
          timedOut: false,
        }),
      }),
    );
  });

  it('bridge object only exposes emitCompleted and emitFailed', () => {
    const bridge = createNotificationBridge({ onCompleted: vi.fn(), onFailed: vi.fn() });
    expect(Object.keys(bridge).sort()).toEqual(['emitCompleted', 'emitFailed'].sort());
  });
});
