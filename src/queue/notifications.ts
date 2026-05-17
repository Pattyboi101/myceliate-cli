// src/queue/notifications.ts
import type { BashJobReturn } from './queues.js';

export type JobOutcome = {
  jobId: string;
  toolUseId: string;
  queueName: string;
  returnValue: BashJobReturn;
};

export type JobFailure = {
  jobId: string;
  toolUseId: string;
  queueName: string;
  failedReason: string;
};

export type NotificationHandlers = {
  onCompleted: (outcome: JobOutcome) => void;
  onFailed: (failure: JobFailure) => void;
};

export type NotificationBridge = {
  emitCompleted: (outcome: JobOutcome) => void;
  emitFailed: (failure: JobFailure) => void;
};

export function createNotificationBridge(handlers: NotificationHandlers): NotificationBridge {
  return {
    emitCompleted: handlers.onCompleted,
    emitFailed: handlers.onFailed,
  };
}
