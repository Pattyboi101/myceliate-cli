// tests/fixtures/workers/exitNonZero.ts
// Stub worker that exits 1 immediately. Used in workerLifecycle integration tests
// to simulate a crashed worker and verify the orchestrator's pending-jobs Map
// rejects in-flight bash promises within ~100ms instead of waiting BullMQ's stall.
console.log('[stub-worker] exiting 1');
process.exit(1);
