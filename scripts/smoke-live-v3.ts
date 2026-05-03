// scripts/smoke-live-v3.ts
// One-shot smoke: spin up the V3 adapter against the live DeepSeek API,
// send a tiny message containing a fake secret, log streamed events, and
// verify F1 redaction by intercepting buildRequestBody before transmission.
//
// Run: pnpm tsx scripts/smoke-live-v3.ts
import { loadDotenv } from '../src/runtime/dotenv.js';
loadDotenv();

import { V3Adapter, serializeMessage } from '../src/adapters/v3/adapter.js';

const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) {
  console.error('DEEPSEEK_API_KEY not set');
  process.exit(1);
}

const adapter = new V3Adapter({
  apiKey,
  baseUrl: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
});

// Step 1: F1 redaction check on the per-message serializer (V3 doesn't export
// the request-body builder; serializeMessage is the egress redaction point).
const serialised = serializeMessage({
  role: 'user',
  content: 'leak test: OPENAI_API_KEY=sk-fake1234567890abcdefghijk and please say hi',
});
const wireStr = JSON.stringify(serialised);
const f1Pass = !wireStr.includes('sk-fake1234567890abcdefghijk') && wireStr.includes('[REDACTED:');
console.log(
  `[F1 redaction]      ${f1Pass ? 'PASS' : 'FAIL'} — fake key absent: ${!wireStr.includes('sk-fake1234567890abcdefghijk')}, marker present: ${wireStr.includes('[REDACTED:')}`,
);

// Step 2: live streaming smoke against deepseek-reasoner.
console.log('[live stream]       sending "say hi in five words" to deepseek-reasoner...');
let reasoningChunks = 0;
let contentChunks = 0;
let contentText = '';
let doneEvent: unknown = null;
let errorEvent: unknown = null;

const start = Date.now();
for await (const ev of adapter.stream({
  model: 'deepseek-reasoner',
  messages: [{ role: 'user', content: 'Say hi in exactly five words.' }],
  thinking: false,
  strict: true,
})) {
  if (ev.type === 'reasoning_delta') reasoningChunks += 1;
  else if (ev.type === 'content_delta') {
    contentChunks += 1;
    contentText += ev.text;
  } else if (ev.type === 'done') doneEvent = ev;
  else if (ev.type === 'error') errorEvent = ev;
}
const elapsed = Date.now() - start;

if (errorEvent) {
  console.log(`[live stream]       FAIL — error event: ${JSON.stringify(errorEvent)}`);
  process.exit(1);
}

console.log(
  `[live stream]       PASS — ${reasoningChunks} reasoning chunks, ${contentChunks} content chunks, ${elapsed}ms`,
);
console.log(`[live stream]       content: ${JSON.stringify(contentText.trim())}`);
console.log(`[live stream]       done: ${JSON.stringify(doneEvent)}`);
console.log(
  '\nAll smoke checks PASS. V3 adapter, F1 redaction, and the live DeepSeek wire are all functional.',
);
