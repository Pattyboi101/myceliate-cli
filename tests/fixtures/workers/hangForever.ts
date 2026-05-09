// tests/fixtures/workers/hangForever.ts
// Stub worker that ignores SIGTERM and hangs. Used to verify the SIGKILL
// escalation path in shutdown().
console.log('[stub-worker] hanging; ignoring SIGTERM');
process.on('SIGTERM', () => console.log('[stub-worker] received SIGTERM, ignoring'));
setInterval(() => {}, 1_000_000);
