# Myceliate CLI — Vertical Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a working autonomous CLI agent against the DeepSeek V4 spec, runnable today via a V3-reasoner adapter, with the full Thin Agent / Fat Platform architecture in place.

**Architecture:** A central orchestrator runs a streaming ReAct loop driven by a strict V4-shaped `DeepSeekClient` interface. Heavy I/O (bash, builds, tests) is dispatched to BullMQ jobs over Redis. State is persisted as Markdown files (OpenClaw pattern). The TUI uses Ink for the dual-stream layout (collapsible reasoning trace + final content) and Clack for onboarding. Compaction layers 1–3 keep the working context bounded; security gates enforce HITL approval and egress redaction.

**Tech Stack:** Node.js ≥20.11, TypeScript (strict, NodeNext ESM), Ink + React 18, @clack/prompts, BullMQ + ioredis, Zod, Vitest + ink-testing-library, Biome, tsx, Docker Compose for Redis.

**Scope check:** This plan covers the vertical slice. Deferred (do NOT implement here): compaction layers 4 (ACE) and 5 (auto-compaction), dynamic multi-provider routing, daemonised heartbeat, full ephemeral sandboxing, MCP integration. See `CLAUDE.md` for the full deferred list.

**Pre-condition:** The scaffold (package.json, tsconfig, biome, vitest, docker-compose, .gitignore, .env.example, CLAUDE.md, README) is already in place. First task is to install dependencies and verify the toolchain.

---

## File Structure

Each file has one responsibility. Files that change together live together. Splits below are intentional decomposition decisions — do not collapse them.

```
src/
├── index.ts                            # Entry: Clack onboarding → Ink mount
├── adapters/
│   ├── DeepSeekClient.ts               # Strict V4-shaped interface (R1)
│   ├── streamEvent.ts                  # Canonical StreamEvent sum type
│   ├── messages.ts                     # Message / ToolCall / ToolResult types
│   ├── v3/
│   │   ├── adapter.ts                  # V3 reasoner adapter (works today)
│   │   └── parser.ts                   # SSE chunk → JSON tool_calls accumulator
│   └── v4/
│       ├── adapter.ts                  # V4 adapter (DSML wire format)
│       ├── dsmlParser.ts               # DSML state machine
│       └── leakFallback.ts             # Detects raw <|DSML|...> in content/reasoning
├── transport/
│   └── sseClient.ts                    # SSE byte stream primitive (shared)
├── tools/
│   ├── registry.ts                     # Tool registration + JIT skill loading
│   ├── schema.ts                       # Zod → JSON Schema (strict mode)
│   ├── readFile.ts
│   ├── writeFile.ts
│   ├── listDir.ts
│   ├── grep.ts
│   └── bash.ts                         # Heavy: dispatched to BullMQ
├── queue/
│   ├── connection.ts                   # ioredis singleton
│   ├── queues.ts                       # BullMQ queue definitions
│   ├── worker.ts                       # Standalone consumer process entry
│   ├── notifications.ts                # Bridges queue events → orchestrator
│   └── jobs/
│       ├── bashJob.ts                  # spawn() worker for shell commands
│       ├── testJob.ts                  # Test-suite runner job
│       └── dockerJob.ts                # docker build job
├── memory/
│   ├── markdownStore.ts                # File-backed Markdown CRUD
│   ├── claudeMd.ts                     # Project CLAUDE.md loader
│   └── conversationLog.ts              # Append-only history.md per session
├── security/
│   ├── redactor.ts                     # Static regex secret blocklists (egress)
│   ├── dangerousPatterns.ts            # Static regex shell command blocklist
│   └── hitlGate.ts                     # Approval interceptor + event emitter
├── orchestrator/
│   ├── context.ts                      # Env sensing: cwd, git, CLAUDE.md, memory
│   ├── QueryEngine.ts                  # State, history, token attribution
│   ├── reactLoop.ts                    # Async generator implementing ReAct
│   └── compaction/
│       ├── budgetChecker.ts            # Layer 1: budget verification
│       ├── toolOutputPruner.ts         # Layer 1: prune verbose outputs
│       ├── snipper.ts                  # Layer 2: history snipping
│       └── microCompactor.ts           # Layer 3: cache-aware metadata-only
├── ui/
│   ├── App.tsx                         # Top-level Ink component
│   ├── ReasoningBlock.tsx              # Stateful collapsible reasoning trace
│   ├── ContentStream.tsx               # Final answer renderer
│   ├── ApprovalPrompt.tsx              # HITL approval UI
│   ├── onboarding.ts                   # Clack flow (pre-Ink)
│   └── markdown/
│       ├── incrementalParser.ts        # O(n) streaming Markdown tokenizer
│       └── MarkdownRenderer.tsx        # Ink renderer over incremental tokens
└── util/
    ├── tokens.ts                       # Coarse token estimate
    └── logger.ts                       # File logger (never stdout while Ink mounted)

tests/
├── unit/                               # Mirrors src/ structure
└── integration/
    ├── reactLoop.test.ts               # End-to-end with mock V3 adapter
    └── queueRoundTrip.test.ts          # Real Redis (skipIf no $REDIS_URL)
```

---

## Task 0: Install dependencies and verify toolchain

**Files:**

- Modify: `package-lock.json` or `pnpm-lock.yaml` (created by install)

- [ ] **Step 1: Install dependencies**

```bash
cd ~/Myceliate/myceliate-cli && pnpm install
```

Expected: install succeeds, `node_modules/` populated, lockfile created.

If pnpm is unavailable, use `npm install` (slower, less deterministic, but functional).

- [ ] **Step 2: Verify type-check passes on empty src/**

```bash
echo 'export {};' > src/index.ts && pnpm typecheck
```

Expected: zero errors.

- [ ] **Step 3: Verify Vitest can boot**

```bash
pnpm test
```

Expected: "No test files found" message (and exit 0 or similar — vitest may exit 1 on no tests; that's fine, we'll have tests momentarily).

- [ ] **Step 4: Verify Biome can lint**

```bash
pnpm lint
```

Expected: zero errors on the empty src/.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml src/index.ts
git commit -m "chore: install dependencies and verify toolchain"
```

---

## Phase 1 — Canonical Types & SSE Transport

The shared substrate every adapter consumes. Locked down first so V3 and V4 adapters can develop in parallel.

### Task 1: Define the canonical `StreamEvent` sum type

**Files:**

- Create: `src/adapters/streamEvent.ts`
- Test: `tests/unit/adapters/streamEvent.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/adapters/streamEvent.test.ts
import { describe, it, expect } from 'vitest';
import type { StreamEvent } from '../../../src/adapters/streamEvent.js';
import { isToolCall, isContentDelta, isReasoningDelta, isDone } from '../../../src/adapters/streamEvent.js';

describe('StreamEvent', () => {
  it('discriminates reasoning_delta, content_delta, tool_call, done, error', () => {
    const events: StreamEvent[] = [
      { type: 'reasoning_delta', text: 'thinking…' },
      { type: 'content_delta', text: 'hello' },
      { type: 'tool_call', id: 't1', name: 'read_file', args: { path: '/etc/hosts' } },
      { type: 'done', usage: { promptTokens: 10, completionTokens: 5, reasoningTokens: 3 } },
      { type: 'error', cause: new Error('boom') },
    ];
    expect(events.filter(isReasoningDelta)).toHaveLength(1);
    expect(events.filter(isContentDelta)).toHaveLength(1);
    expect(events.filter(isToolCall)).toHaveLength(1);
    expect(events.filter(isDone)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test to verify failure**

```bash
pnpm test tests/unit/adapters/streamEvent.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `streamEvent.ts`**

```ts
// src/adapters/streamEvent.ts
export type Usage = {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cacheHitTokens?: number;
};

export type StreamEvent =
  | { type: 'reasoning_delta'; text: string }
  | { type: 'content_delta'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | { type: 'done'; usage: Usage }
  | { type: 'error'; cause: Error };

export const isReasoningDelta = (e: StreamEvent): e is Extract<StreamEvent, { type: 'reasoning_delta' }> =>
  e.type === 'reasoning_delta';
export const isContentDelta = (e: StreamEvent): e is Extract<StreamEvent, { type: 'content_delta' }> =>
  e.type === 'content_delta';
export const isToolCall = (e: StreamEvent): e is Extract<StreamEvent, { type: 'tool_call' }> =>
  e.type === 'tool_call';
export const isDone = (e: StreamEvent): e is Extract<StreamEvent, { type: 'done' }> =>
  e.type === 'done';
export const isError = (e: StreamEvent): e is Extract<StreamEvent, { type: 'error' }> =>
  e.type === 'error';
```

- [ ] **Step 4: Run the test to verify pass**

```bash
pnpm test tests/unit/adapters/streamEvent.test.ts
```

Expected: PASS — 1 test.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/streamEvent.ts tests/unit/adapters/streamEvent.test.ts
git commit -m "feat(adapters): canonical StreamEvent sum type with type guards"
```

---

### Task 2: Define `Message`, `ToolCall`, `ToolResult` history types

**Files:**

- Create: `src/adapters/messages.ts`
- Test: `tests/unit/adapters/messages.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/adapters/messages.test.ts
import { describe, it, expect } from 'vitest';
import type { Message } from '../../../src/adapters/messages.js';
import { hasToolCalls, hasReasoningContent } from '../../../src/adapters/messages.js';

describe('Message', () => {
  it('detects assistant messages with tool calls (R2: reasoning_content must be retained)', () => {
    const m: Message = {
      role: 'assistant',
      content: '',
      reasoning_content: 'I should read the file first',
      tool_calls: [{ id: 't1', name: 'read_file', args: { path: 'a.txt' } }],
    };
    expect(hasToolCalls(m)).toBe(true);
    expect(hasReasoningContent(m)).toBe(true);
  });

  it('flags assistant messages without tool calls (R2: reasoning_content can be discarded)', () => {
    const m: Message = { role: 'assistant', content: 'final answer' };
    expect(hasToolCalls(m)).toBe(false);
    expect(hasReasoningContent(m)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm test tests/unit/adapters/messages.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `messages.ts`**

```ts
// src/adapters/messages.ts
export type ToolCall = {
  id: string;
  name: string;
  args: unknown;
};

export type ToolResult = {
  tool_use_id: string;
  command: string;          // For R10 layer 3: preserved during micro-compaction.
  is_error: boolean;
  content: string;          // Cleared by micro-compaction; metadata above is kept.
};

export type SystemMessage = { role: 'system'; content: string };
export type UserMessage = { role: 'user'; content: string };
export type AssistantMessage = {
  role: 'assistant';
  content: string;
  reasoning_content?: string;
  tool_calls?: ToolCall[];
};
export type ToolResultMessage = { role: 'tool'; result: ToolResult };

export type Message =
  | SystemMessage
  | UserMessage
  | AssistantMessage
  | ToolResultMessage;

export const hasToolCalls = (m: Message): m is AssistantMessage & { tool_calls: ToolCall[] } =>
  m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0;

export const hasReasoningContent = (m: Message): m is AssistantMessage & { reasoning_content: string } =>
  m.role === 'assistant' && typeof m.reasoning_content === 'string' && m.reasoning_content.length > 0;
```

- [ ] **Step 4: Run to verify pass**

```bash
pnpm test tests/unit/adapters/messages.test.ts
```

Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/messages.ts tests/unit/adapters/messages.test.ts
git commit -m "feat(adapters): Message/ToolCall/ToolResult types with R2 helpers"
```

---

### Task 3: Build the SSE byte-stream primitive

**Files:**

- Create: `src/transport/sseClient.ts`
- Test: `tests/unit/adapters/sseClient.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/adapters/sseClient.test.ts
import { describe, it, expect } from 'vitest';
import { parseSseStream } from '../../../src/transport/sseClient.js';

const encoder = new TextEncoder();

async function* chunks(...parts: string[]): AsyncIterable<Uint8Array> {
  for (const p of parts) yield encoder.encode(p);
}

describe('parseSseStream', () => {
  it('emits one event per data: line, terminating on [DONE]', async () => {
    const stream = chunks(
      'data: {"a":1}\n\n',
      'data: {"a":2}\n\n',
      'data: [DONE]\n\n',
    );
    const events: string[] = [];
    for await (const ev of parseSseStream(stream)) events.push(ev);
    expect(events).toEqual(['{"a":1}', '{"a":2}']);
  });

  it('reassembles events split mid-chunk', async () => {
    const stream = chunks('data: {"a"', ':1}\n\nda', 'ta: {"a":2}\n\n', 'data: [DONE]\n\n');
    const events: string[] = [];
    for await (const ev of parseSseStream(stream)) events.push(ev);
    expect(events).toEqual(['{"a":1}', '{"a":2}']);
  });

  it('ignores comment lines and empty data', async () => {
    const stream = chunks(': keep-alive\n\ndata: {"a":1}\n\ndata: [DONE]\n\n');
    const events: string[] = [];
    for await (const ev of parseSseStream(stream)) events.push(ev);
    expect(events).toEqual(['{"a":1}']);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm test tests/unit/adapters/sseClient.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `sseClient.ts`**

```ts
// src/transport/sseClient.ts
const DONE_MARKER = '[DONE]';

export async function* parseSseStream(
  byteStream: AsyncIterable<Uint8Array>,
): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of byteStream) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n\n')) !== -1) {
      const event = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 2);
      const payload = extractDataPayload(event);
      if (payload === null) continue;
      if (payload === DONE_MARKER) return;
      yield payload;
    }
  }
  // Drain any final event if the stream closed without trailing \n\n.
  if (buffer.length > 0) {
    const payload = extractDataPayload(buffer);
    if (payload !== null && payload !== DONE_MARKER) yield payload;
  }
}

function extractDataPayload(event: string): string | null {
  const lines = event.split('\n');
  const dataLines = lines.filter((l) => l.startsWith('data:'));
  if (dataLines.length === 0) return null;
  return dataLines.map((l) => l.slice(5).trimStart()).join('\n');
}

export type FetchInit = {
  url: string;
  body: unknown;
  headers: Record<string, string>;
  signal?: AbortSignal;
};

export async function openSseConnection(init: FetchInit): Promise<AsyncIterable<Uint8Array>> {
  const res = await fetch(init.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...init.headers },
    body: JSON.stringify(init.body),
    signal: init.signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`SSE connection failed: ${res.status} ${res.statusText}`);
  }
  return res.body as unknown as AsyncIterable<Uint8Array>;
}
```

- [ ] **Step 4: Run to verify pass**

```bash
pnpm test tests/unit/adapters/sseClient.test.ts
```

Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/transport/sseClient.ts tests/unit/adapters/sseClient.test.ts
git commit -m "feat(transport): SSE parser handling chunk splits, comments, [DONE]"
```

---

### Task 4: Define the `DeepSeekClient` interface (V4-shaped)

**Files:**

- Create: `src/adapters/DeepSeekClient.ts`
- Test: `tests/unit/adapters/DeepSeekClient.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/adapters/DeepSeekClient.test.ts
import { describe, it, expectTypeOf } from 'vitest';
import type { DeepSeekClient, ChatRequest } from '../../../src/adapters/DeepSeekClient.js';
import type { StreamEvent } from '../../../src/adapters/streamEvent.js';

describe('DeepSeekClient interface', () => {
  it('mandates a streaming entry point that yields canonical StreamEvents', () => {
    type StreamFn = DeepSeekClient['stream'];
    expectTypeOf<StreamFn>().toBeFunction();
    expectTypeOf<ReturnType<StreamFn>>().toEqualTypeOf<AsyncIterable<StreamEvent>>();
  });

  it('mandates ChatRequest carries thinking flag and strict-mode tool defs', () => {
    expectTypeOf<ChatRequest['thinking']>().toEqualTypeOf<boolean>();
    expectTypeOf<ChatRequest['tools']>().toMatchTypeOf<readonly { name: string; description: string; parameters: object }[] | undefined>();
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm test tests/unit/adapters/DeepSeekClient.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `DeepSeekClient.ts`**

```ts
// src/adapters/DeepSeekClient.ts
import type { Message } from './messages.js';
import type { StreamEvent } from './streamEvent.js';

export type ToolDefinition = {
  name: string;
  description: string;
  /** JSON Schema with `additionalProperties: false` and every prop in `required` (R3). */
  parameters: object;
};

export type ChatRequest = {
  model: string;
  messages: Message[];
  tools?: readonly ToolDefinition[];
  thinking: boolean;          // V4 Thinking Mode toggle.
  strict: boolean;            // R3: enforce strict schema validation server-side.
  signal?: AbortSignal;
  /** Implementation-specific extras (sampling params etc.) — kept opaque. */
  options?: Readonly<Record<string, unknown>>;
};

export interface DeepSeekClient {
  /**
   * Streams canonical events. Adapters own their wire format end-to-end (R1):
   * the V3 adapter parses JSON tool_calls, the V4 adapter parses DSML markers.
   * Callers consume only StreamEvent.
   */
  stream(req: ChatRequest): AsyncIterable<StreamEvent>;

  /** Adapter identifier for logging / telemetry. */
  readonly id: 'v3' | 'v4';
}
```

- [ ] **Step 4: Run to verify pass**

```bash
pnpm test tests/unit/adapters/DeepSeekClient.test.ts
```

Expected: PASS — 2 tests (type-only assertions).

- [ ] **Step 5: Commit**

```bash
git add src/adapters/DeepSeekClient.ts tests/unit/adapters/DeepSeekClient.test.ts
git commit -m "feat(adapters): DeepSeekClient interface shaped to V4 (Thinking, strict)"
```

---

## Phase 2 — V3 Reasoner Adapter (works today)

### Task 5: V3 SSE chunk parser (JSON delta accumulator)

**Files:**

- Create: `src/adapters/v3/parser.ts`
- Test: `tests/unit/adapters/v3-parser.test.ts`

The DeepSeek V3 reasoner returns OpenAI-compatible SSE chunks where each chunk is a JSON object with a `choices[0].delta` containing `content`, `reasoning_content`, and incrementally-assembled `tool_calls` arrays. The parser converts each parsed JSON chunk into one or more canonical `StreamEvent`s.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/adapters/v3-parser.test.ts
import { describe, it, expect } from 'vitest';
import { parseV3Chunk, V3StreamState } from '../../../src/adapters/v3/parser.js';
import type { StreamEvent } from '../../../src/adapters/streamEvent.js';

function collect(state: V3StreamState, jsonChunks: string[]): StreamEvent[] {
  const out: StreamEvent[] = [];
  for (const j of jsonChunks) for (const e of parseV3Chunk(state, j)) out.push(e);
  return out;
}

describe('parseV3Chunk', () => {
  it('emits reasoning_delta for reasoning_content fragments', () => {
    const s = new V3StreamState();
    const events = collect(s, [
      JSON.stringify({ choices: [{ delta: { reasoning_content: 'I need ' } }] }),
      JSON.stringify({ choices: [{ delta: { reasoning_content: 'to think' } }] }),
    ]);
    expect(events).toEqual([
      { type: 'reasoning_delta', text: 'I need ' },
      { type: 'reasoning_delta', text: 'to think' },
    ]);
  });

  it('emits content_delta for content fragments', () => {
    const s = new V3StreamState();
    const events = collect(s, [
      JSON.stringify({ choices: [{ delta: { content: 'Hello ' } }] }),
      JSON.stringify({ choices: [{ delta: { content: 'world' } }] }),
    ]);
    expect(events).toEqual([
      { type: 'content_delta', text: 'Hello ' },
      { type: 'content_delta', text: 'world' },
    ]);
  });

  it('accumulates a tool_call across delta chunks and emits once on completion', () => {
    const s = new V3StreamState();
    const events = collect(s, [
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"pa' } }] } }] }),
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    ]);
    expect(events).toContainEqual({
      type: 'tool_call',
      id: 'call_1',
      name: 'read_file',
      args: { path: 'a.txt' },
    });
  });

  it('emits done with usage on the final chunk', () => {
    const s = new V3StreamState();
    const events = collect(s, [
      JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, completion_tokens_details: { reasoning_tokens: 5 } } }),
    ]);
    expect(events.at(-1)).toEqual({
      type: 'done',
      usage: { promptTokens: 10, completionTokens: 2, reasoningTokens: 5 },
    });
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm test tests/unit/adapters/v3-parser.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `parser.ts`**

```ts
// src/adapters/v3/parser.ts
import type { StreamEvent } from '../streamEvent.js';

type PendingToolCall = {
  id: string;
  name: string;
  argsBuffer: string;
};

export class V3StreamState {
  pending = new Map<number, PendingToolCall>();
}

type V3DeltaChunk = {
  choices?: Array<{
    delta?: {
      content?: string;
      reasoning_content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
    prompt_cache_hit_tokens?: number;
  };
};

export function* parseV3Chunk(state: V3StreamState, json: string): Generator<StreamEvent> {
  let chunk: V3DeltaChunk;
  try {
    chunk = JSON.parse(json) as V3DeltaChunk;
  } catch (cause) {
    yield { type: 'error', cause: cause instanceof Error ? cause : new Error(String(cause)) };
    return;
  }

  const choice = chunk.choices?.[0];
  const delta = choice?.delta;

  if (delta?.reasoning_content) {
    yield { type: 'reasoning_delta', text: delta.reasoning_content };
  }
  if (delta?.content) {
    yield { type: 'content_delta', text: delta.content };
  }
  if (delta?.tool_calls) {
    for (const tc of delta.tool_calls) {
      const existing = state.pending.get(tc.index);
      if (existing === undefined) {
        state.pending.set(tc.index, {
          id: tc.id ?? '',
          name: tc.function?.name ?? '',
          argsBuffer: tc.function?.arguments ?? '',
        });
      } else {
        if (tc.id !== undefined) existing.id = tc.id;
        if (tc.function?.name !== undefined) existing.name = tc.function.name;
        if (tc.function?.arguments !== undefined) existing.argsBuffer += tc.function.arguments;
      }
    }
  }

  if (choice?.finish_reason === 'tool_calls') {
    for (const pending of state.pending.values()) {
      let args: unknown = {};
      try {
        args = JSON.parse(pending.argsBuffer || '{}');
      } catch (cause) {
        yield { type: 'error', cause: new Error(`Tool call args JSON parse failed: ${pending.argsBuffer}`, { cause: cause instanceof Error ? cause : undefined }) };
        continue;
      }
      yield { type: 'tool_call', id: pending.id, name: pending.name, args };
    }
    state.pending.clear();
  }

  if (chunk.usage !== undefined && (choice?.finish_reason === 'stop' || choice?.finish_reason === 'tool_calls')) {
    yield {
      type: 'done',
      usage: {
        promptTokens: chunk.usage.prompt_tokens ?? 0,
        completionTokens: chunk.usage.completion_tokens ?? 0,
        reasoningTokens: chunk.usage.completion_tokens_details?.reasoning_tokens ?? 0,
        ...(chunk.usage.prompt_cache_hit_tokens !== undefined
          ? { cacheHitTokens: chunk.usage.prompt_cache_hit_tokens }
          : {}),
      },
    };
  }
}
```

- [ ] **Step 4: Run to verify pass**

```bash
pnpm test tests/unit/adapters/v3-parser.test.ts
```

Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/v3/parser.ts tests/unit/adapters/v3-parser.test.ts
git commit -m "feat(adapters/v3): SSE chunk parser yielding canonical StreamEvents"
```

---

### Task 6: V3 adapter (composes SSE + parser)

**Files:**

- Create: `src/adapters/v3/adapter.ts`
- Test: `tests/unit/adapters/v3-adapter.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/adapters/v3-adapter.test.ts
import { describe, it, expect, vi } from 'vitest';
import { V3Adapter } from '../../../src/adapters/v3/adapter.js';
import type { StreamEvent } from '../../../src/adapters/streamEvent.js';

const encoder = new TextEncoder();

async function* sseFixture(): AsyncIterable<Uint8Array> {
  const lines = [
    'data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"completion_tokens_details":{"reasoning_tokens":2}}}\n\n',
    'data: [DONE]\n\n',
  ];
  for (const l of lines) yield encoder.encode(l);
}

describe('V3Adapter', () => {
  it('streams canonical events end-to-end via injected SSE opener', async () => {
    const opener = vi.fn().mockResolvedValue(sseFixture());
    const adapter = new V3Adapter({
      apiKey: 'sk-test',
      baseUrl: 'https://api.test',
      openSse: opener,
    });
    const events: StreamEvent[] = [];
    for await (const e of adapter.stream({
      model: 'deepseek-reasoner',
      messages: [{ role: 'user', content: 'hi' }],
      thinking: true,
      strict: true,
    })) events.push(e);
    expect(events.map((e) => e.type)).toEqual(['reasoning_delta', 'content_delta', 'done']);
    expect(opener).toHaveBeenCalledOnce();
    const sentBody = opener.mock.calls[0]![0].body as { stream: boolean; messages: unknown[] };
    expect(sentBody.stream).toBe(true);
  });

  it('exposes id "v3"', () => {
    const adapter = new V3Adapter({ apiKey: 'k', baseUrl: 'x', openSse: vi.fn() });
    expect(adapter.id).toBe('v3');
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm test tests/unit/adapters/v3-adapter.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `adapter.ts`**

```ts
// src/adapters/v3/adapter.ts
import type { ChatRequest, DeepSeekClient } from '../DeepSeekClient.js';
import type { StreamEvent } from '../streamEvent.js';
import { parseSseStream, openSseConnection, type FetchInit } from '../../transport/sseClient.js';
import { parseV3Chunk, V3StreamState } from './parser.js';

type SseOpener = (init: FetchInit) => Promise<AsyncIterable<Uint8Array>>;

export type V3AdapterOptions = {
  apiKey: string;
  baseUrl: string;
  openSse?: SseOpener;
};

export class V3Adapter implements DeepSeekClient {
  readonly id = 'v3' as const;
  private readonly opener: SseOpener;

  constructor(private readonly opts: V3AdapterOptions) {
    this.opener = opts.openSse ?? openSseConnection;
  }

  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    const body = {
      model: req.model,
      messages: req.messages.map(this.serializeMessage),
      stream: true,
      ...(req.tools !== undefined
        ? {
            tools: req.tools.map((t) => ({
              type: 'function',
              function: { name: t.name, description: t.description, parameters: t.parameters, strict: req.strict },
            })),
            tool_choice: 'auto',
          }
        : {}),
      ...(req.options ?? {}),
    };
    const byteStream = await this.opener({
      url: `${this.opts.baseUrl}/v1/chat/completions`,
      body,
      headers: { authorization: `Bearer ${this.opts.apiKey}` },
      ...(req.signal ? { signal: req.signal } : {}),
    });

    const state = new V3StreamState();
    for await (const json of parseSseStream(byteStream)) {
      for (const event of parseV3Chunk(state, json)) yield event;
    }
  }

  private serializeMessage = (m: import('../messages.js').Message): unknown => {
    switch (m.role) {
      case 'system':
      case 'user':
        return { role: m.role, content: m.content };
      case 'assistant': {
        const out: Record<string, unknown> = { role: 'assistant', content: m.content };
        if (m.reasoning_content) out.reasoning_content = m.reasoning_content;
        if (m.tool_calls) {
          out.tool_calls = m.tool_calls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.args) },
          }));
        }
        return out;
      }
      case 'tool':
        return { role: 'tool', tool_call_id: m.result.tool_use_id, content: m.result.content };
    }
  };
}
```

- [ ] **Step 4: Run to verify pass**

```bash
pnpm test tests/unit/adapters/v3-adapter.test.ts
```

Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/v3/adapter.ts tests/unit/adapters/v3-adapter.test.ts
git commit -m "feat(adapters/v3): adapter composing SSE transport and chunk parser"
```

---

## Phase 3 — V4 DSML Adapter (scaffold)

The V4 adapter parses DSML markup (`<|DSML|tool_calls> ... </|DSML|tool_calls>`) with `string="true"/"false"` parameter bifurcation. It includes a leak-fallback parser for the documented vLLM/NIM bug where DSML markers leak into `content` or `reasoning_content` fields.

### Task 7: DSML state machine — happy path

**Files:**

- Create: `src/adapters/v4/dsmlParser.ts`
- Test: `tests/unit/adapters/v4-dsmlParser.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/adapters/v4-dsmlParser.test.ts
import { describe, it, expect } from 'vitest';
import { DsmlParser } from '../../../src/adapters/v4/dsmlParser.js';

describe('DsmlParser — happy path', () => {
  it('extracts a single tool call with mixed string/structured params', () => {
    const p = new DsmlParser();
    const events = [
      ...p.feed('<|DSML|tool_calls>'),
      ...p.feed('<call id="t1" name="bash">'),
      ...p.feed('<param key="cmd" string="true">echo "hi"</param>'),
      ...p.feed('<param key="timeout" string="false">5000</param>'),
      ...p.feed('</call>'),
      ...p.feed('</|DSML|tool_calls>'),
    ];
    expect(events).toEqual([
      { type: 'tool_call', id: 't1', name: 'bash', args: { cmd: 'echo "hi"', timeout: 5000 } },
    ]);
  });

  it('preserves text outside DSML markers as content', () => {
    const p = new DsmlParser();
    const events = [
      ...p.feed('Some thinking text. '),
      ...p.feed('<|DSML|tool_calls><call id="x" name="ls"></call></|DSML|tool_calls>'),
      ...p.feed(' Trailing.'),
    ];
    expect(events).toContainEqual({ type: 'content_delta', text: 'Some thinking text. ' });
    expect(events).toContainEqual({ type: 'tool_call', id: 'x', name: 'ls', args: {} });
    expect(events).toContainEqual({ type: 'content_delta', text: ' Trailing.' });
  });

  it('handles markers split across feeds', () => {
    const p = new DsmlParser();
    const events = [
      ...p.feed('<|DSML|tool_'),
      ...p.feed('calls><call id="a" name="b"></call></|DSML|tool_calls>'),
    ];
    expect(events).toContainEqual({ type: 'tool_call', id: 'a', name: 'b', args: {} });
  });

  it('handles structured array param', () => {
    const p = new DsmlParser();
    const events = [
      ...p.feed('<|DSML|tool_calls><call id="t" name="x">'),
      ...p.feed('<param key="paths" string="false">["a","b"]</param>'),
      ...p.feed('</call></|DSML|tool_calls>'),
    ];
    expect(events).toContainEqual({ type: 'tool_call', id: 't', name: 'x', args: { paths: ['a', 'b'] } });
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm test tests/unit/adapters/v4-dsmlParser.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `dsmlParser.ts`**

```ts
// src/adapters/v4/dsmlParser.ts
import type { StreamEvent } from '../streamEvent.js';

const OPEN_BLOCK = '<|DSML|tool_calls>';
const CLOSE_BLOCK = '</|DSML|tool_calls>';

type Mode = 'content' | 'block';

type PendingParam = { key: string; isString: boolean; value: string };
type PendingCall = { id: string; name: string; params: PendingParam[]; current: PendingParam | null };

export class DsmlParser {
  private buffer = '';
  private mode: Mode = 'content';
  private call: PendingCall | null = null;

  feed(chunk: string): StreamEvent[] {
    this.buffer += chunk;
    const out: StreamEvent[] = [];
    let progress = true;
    while (progress) {
      progress = false;
      if (this.mode === 'content') {
        const openIdx = this.buffer.indexOf(OPEN_BLOCK);
        if (openIdx === -1) {
          // Emit safe prefix that cannot be the start of OPEN_BLOCK.
          const safe = this.safeContentPrefix(this.buffer);
          if (safe.length > 0) {
            out.push({ type: 'content_delta', text: safe });
            this.buffer = this.buffer.slice(safe.length);
          }
        } else {
          if (openIdx > 0) {
            out.push({ type: 'content_delta', text: this.buffer.slice(0, openIdx) });
          }
          this.buffer = this.buffer.slice(openIdx + OPEN_BLOCK.length);
          this.mode = 'block';
          progress = true;
        }
      } else {
        const closeIdx = this.buffer.indexOf(CLOSE_BLOCK);
        const segmentEnd = closeIdx === -1 ? this.buffer.length : closeIdx;
        const consumed = this.consumeBlockSegment(this.buffer.slice(0, segmentEnd), out);
        this.buffer = this.buffer.slice(consumed) + (closeIdx === -1 ? '' : '');
        if (closeIdx !== -1 && consumed === segmentEnd) {
          this.buffer = this.buffer.slice(CLOSE_BLOCK.length);
          this.mode = 'content';
          this.call = null;
          progress = true;
        }
      }
    }
    return out;
  }

  /** Returns the prefix of `s` that is guaranteed not to start `OPEN_BLOCK`. */
  private safeContentPrefix(s: string): string {
    for (let i = 1; i < OPEN_BLOCK.length && i <= s.length; i++) {
      const tail = s.slice(s.length - i);
      if (OPEN_BLOCK.startsWith(tail)) return s.slice(0, s.length - i);
    }
    return s;
  }

  private consumeBlockSegment(segment: string, out: StreamEvent[]): number {
    // Minimal tag tokenizer: <call id="..." name="...">, <param key="..." string="...">VALUE</param>, </call>.
    let i = 0;
    while (i < segment.length) {
      const lt = segment.indexOf('<', i);
      if (lt === -1) return i; // No more tags this segment; wait for more bytes.
      const gt = segment.indexOf('>', lt);
      if (gt === -1) return i; // Incomplete tag; wait.
      const tag = segment.slice(lt, gt + 1);
      i = gt + 1;
      if (tag.startsWith('<call ')) {
        const id = readAttr(tag, 'id');
        const name = readAttr(tag, 'name');
        this.call = { id, name, params: [], current: null };
      } else if (tag === '</call>') {
        if (this.call) {
          const args: Record<string, unknown> = {};
          for (const p of this.call.params) args[p.key] = p.isString ? p.value : safeJsonParse(p.value);
          out.push({ type: 'tool_call', id: this.call.id, name: this.call.name, args });
          this.call = null;
        }
      } else if (tag.startsWith('<param ')) {
        if (this.call) {
          const key = readAttr(tag, 'key');
          const isString = readAttr(tag, 'string') === 'true';
          this.call.current = { key, isString, value: '' };
        }
      } else if (tag === '</param>') {
        if (this.call?.current) {
          this.call.params.push(this.call.current);
          this.call.current = null;
        }
      } else {
        // Unknown tag inside a block — treat as part of the current param value verbatim.
        if (this.call?.current) this.call.current.value += tag;
      }
      // Capture text between tags as the current param's value.
      const nextLt = segment.indexOf('<', i);
      const text = segment.slice(i, nextLt === -1 ? segment.length : nextLt);
      if (text.length > 0 && this.call?.current) {
        this.call.current.value += text;
      }
      i += text.length;
    }
    return i;
  }
}

function readAttr(tag: string, name: string): string {
  const re = new RegExp(`${name}="([^"]*)"`);
  const m = tag.match(re);
  return m?.[1] ?? '';
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
```

- [ ] **Step 4: Run to verify pass**

```bash
pnpm test tests/unit/adapters/v4-dsmlParser.test.ts
```

Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/v4/dsmlParser.ts tests/unit/adapters/v4-dsmlParser.test.ts
git commit -m "feat(adapters/v4): DSML state-machine parser with chunk-split safety"
```

---

### Task 8: vLLM/NIM leak fallback parser

**Files:**

- Create: `src/adapters/v4/leakFallback.ts`
- Test: `tests/unit/adapters/v4-leakFallback.test.ts`

Per Doc 3 line 43 / Doc 4 ref 142: middleware servers (vLLM, NVIDIA NIM) sometimes fail to intercept DSML markers, leaving raw `<|DSML|tool_calls>...` strings in `content` or `reasoning_content`. This module rescues those.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/adapters/v4-leakFallback.test.ts
import { describe, it, expect } from 'vitest';
import { detectLeakedDsml } from '../../../src/adapters/v4/leakFallback.js';

describe('detectLeakedDsml', () => {
  it('detects DSML markers leaked into a content stream', () => {
    const result = detectLeakedDsml('Some text <|DSML|tool_calls><call id="t1" name="bash"><param key="cmd" string="true">ls</param></call></|DSML|tool_calls>');
    expect(result).toEqual({
      cleanedText: 'Some text ',
      toolCalls: [{ id: 't1', name: 'bash', args: { cmd: 'ls' } }],
    });
  });

  it('returns null toolCalls when no leak present', () => {
    const result = detectLeakedDsml('Just normal text.');
    expect(result.toolCalls).toEqual([]);
    expect(result.cleanedText).toBe('Just normal text.');
  });

  it('handles multiple leaked tool calls', () => {
    const result = detectLeakedDsml('<|DSML|tool_calls><call id="a" name="x"></call><call id="b" name="y"></call></|DSML|tool_calls>');
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0]?.id).toBe('a');
    expect(result.toolCalls[1]?.id).toBe('b');
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm test tests/unit/adapters/v4-leakFallback.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `leakFallback.ts`**

```ts
// src/adapters/v4/leakFallback.ts
import type { ToolCall } from '../messages.js';
import { DsmlParser } from './dsmlParser.js';
import { isToolCall, isContentDelta } from '../streamEvent.js';

export type LeakResult = { cleanedText: string; toolCalls: ToolCall[] };

export function detectLeakedDsml(text: string): LeakResult {
  if (!text.includes('<|DSML|tool_calls>')) return { cleanedText: text, toolCalls: [] };
  const parser = new DsmlParser();
  const events = parser.feed(text);
  const toolCalls: ToolCall[] = [];
  let cleanedText = '';
  for (const ev of events) {
    if (isToolCall(ev)) toolCalls.push({ id: ev.id, name: ev.name, args: ev.args });
    else if (isContentDelta(ev)) cleanedText += ev.text;
  }
  return { cleanedText, toolCalls };
}
```

- [ ] **Step 4: Run to verify pass**

```bash
pnpm test tests/unit/adapters/v4-leakFallback.test.ts
```

Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/v4/leakFallback.ts tests/unit/adapters/v4-leakFallback.test.ts
git commit -m "feat(adapters/v4): rescue parser for vLLM/NIM DSML leaks"
```

---

### Task 9: V4 adapter (composes SSE + DSML + leak fallback)

**Files:**

- Create: `src/adapters/v4/adapter.ts`
- Test: `tests/unit/adapters/v4-adapter.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/adapters/v4-adapter.test.ts
import { describe, it, expect, vi } from 'vitest';
import { V4Adapter } from '../../../src/adapters/v4/adapter.js';

const enc = new TextEncoder();

async function* fixture(): AsyncIterable<Uint8Array> {
  // V4 SSE: each chunk has {choices:[{delta:{reasoning_content?, content?}}]}.
  // Tool calls arrive as DSML markup inside content.
  const lines = [
    'data: {"choices":[{"delta":{"reasoning_content":"plan: read"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"<|DSML|tool_calls>"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"<call id=\\"t1\\" name=\\"read_file\\">"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"<param key=\\"path\\" string=\\"true\\">a.txt</param>"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"</call></|DSML|tool_calls>"}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":12,"completion_tokens":8,"completion_tokens_details":{"reasoning_tokens":4}}}\n\n',
    'data: [DONE]\n\n',
  ];
  for (const l of lines) yield enc.encode(l);
}

describe('V4Adapter', () => {
  it('parses DSML tool calls embedded in SSE content frames', async () => {
    const adapter = new V4Adapter({ apiKey: 'k', baseUrl: 'x', openSse: vi.fn().mockResolvedValue(fixture()) });
    const events = [];
    for await (const e of adapter.stream({
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: 'read a.txt' }],
      thinking: true,
      strict: true,
    })) events.push(e);
    expect(events).toContainEqual({ type: 'reasoning_delta', text: 'plan: read' });
    expect(events).toContainEqual({ type: 'tool_call', id: 't1', name: 'read_file', args: { path: 'a.txt' } });
    expect(events.at(-1)).toMatchObject({ type: 'done' });
  });

  it('exposes id "v4"', () => {
    const adapter = new V4Adapter({ apiKey: 'k', baseUrl: 'x', openSse: vi.fn() });
    expect(adapter.id).toBe('v4');
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm test tests/unit/adapters/v4-adapter.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `adapter.ts`**

```ts
// src/adapters/v4/adapter.ts
import type { ChatRequest, DeepSeekClient } from '../DeepSeekClient.js';
import type { Message } from '../messages.js';
import type { StreamEvent } from '../streamEvent.js';
import { parseSseStream, openSseConnection, type FetchInit } from '../../transport/sseClient.js';
import { DsmlParser } from './dsmlParser.js';

type SseOpener = (init: FetchInit) => Promise<AsyncIterable<Uint8Array>>;

export type V4AdapterOptions = {
  apiKey: string;
  baseUrl: string;
  openSse?: SseOpener;
};

type V4Chunk = {
  choices?: Array<{
    delta?: { content?: string; reasoning_content?: string };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number }; prompt_cache_hit_tokens?: number };
};

export class V4Adapter implements DeepSeekClient {
  readonly id = 'v4' as const;
  private readonly opener: SseOpener;

  constructor(private readonly opts: V4AdapterOptions) {
    this.opener = opts.openSse ?? openSseConnection;
  }

  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    const body = {
      model: req.model,
      messages: req.messages.map(this.serializeMessage),
      stream: true,
      thinking: req.thinking,
      ...(req.tools !== undefined
        ? { tools: req.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters, strict: req.strict })) }
        : {}),
      ...(req.options ?? {}),
    };
    const byteStream = await this.opener({
      url: `${this.opts.baseUrl}/v1/chat/completions`,
      body,
      headers: { authorization: `Bearer ${this.opts.apiKey}` },
      ...(req.signal ? { signal: req.signal } : {}),
    });

    const dsml = new DsmlParser();
    for await (const json of parseSseStream(byteStream)) {
      let chunk: V4Chunk;
      try {
        chunk = JSON.parse(json) as V4Chunk;
      } catch (cause) {
        yield { type: 'error', cause: cause instanceof Error ? cause : new Error(String(cause)) };
        continue;
      }
      const choice = chunk.choices?.[0];
      const delta = choice?.delta;
      if (delta?.reasoning_content) yield { type: 'reasoning_delta', text: delta.reasoning_content };
      if (delta?.content) for (const e of dsml.feed(delta.content)) yield e;
      if (chunk.usage !== undefined && (choice?.finish_reason === 'stop' || choice?.finish_reason === 'tool_calls')) {
        yield {
          type: 'done',
          usage: {
            promptTokens: chunk.usage.prompt_tokens ?? 0,
            completionTokens: chunk.usage.completion_tokens ?? 0,
            reasoningTokens: chunk.usage.completion_tokens_details?.reasoning_tokens ?? 0,
            ...(chunk.usage.prompt_cache_hit_tokens !== undefined ? { cacheHitTokens: chunk.usage.prompt_cache_hit_tokens } : {}),
          },
        };
      }
    }
  }

  private serializeMessage = (m: Message): unknown => {
    switch (m.role) {
      case 'system':
      case 'user':
        return { role: m.role, content: m.content };
      case 'assistant': {
        const out: Record<string, unknown> = { role: 'assistant', content: m.content };
        if (m.reasoning_content) out.reasoning_content = m.reasoning_content;
        if (m.tool_calls) {
          // V4 expects historical tool_calls re-serialized into DSML for context continuity.
          out.content = `${m.content}<|DSML|tool_calls>${m.tool_calls
            .map((tc) => `<call id="${tc.id}" name="${tc.name}">${this.serializeArgs(tc.args)}</call>`)
            .join('')}</|DSML|tool_calls>`;
        }
        return out;
      }
      case 'tool':
        return { role: 'tool', tool_call_id: m.result.tool_use_id, content: m.result.content };
    }
  };

  private serializeArgs(args: unknown): string {
    if (args === null || typeof args !== 'object') return '';
    return Object.entries(args as Record<string, unknown>)
      .map(([k, v]) => {
        const isString = typeof v === 'string';
        const value = isString ? (v as string) : JSON.stringify(v);
        return `<param key="${k}" string="${isString}">${value}</param>`;
      })
      .join('');
  }
}
```

- [ ] **Step 4: Run to verify pass**

```bash
pnpm test tests/unit/adapters/v4-adapter.test.ts
```

Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/v4/adapter.ts tests/unit/adapters/v4-adapter.test.ts
git commit -m "feat(adapters/v4): adapter composing SSE, DSML parser, V4 message shape"
```

---

### Task 10: Cross-adapter parity test (V3 vs V4 produce the same StreamEvents for equivalent fixtures)

**Files:**

- Test: `tests/unit/adapters/parity.test.ts`

This test enforces R1: regardless of wire format, both adapters produce the same canonical events for semantically equivalent inputs. Future provider adapters must pass it too.

- [ ] **Step 1: Write the failing test (will pass immediately if both adapters work)**

```ts
// tests/unit/adapters/parity.test.ts
import { describe, it, expect, vi } from 'vitest';
import { V3Adapter } from '../../../src/adapters/v3/adapter.js';
import { V4Adapter } from '../../../src/adapters/v4/adapter.js';
import type { StreamEvent } from '../../../src/adapters/streamEvent.js';
import type { ChatRequest } from '../../../src/adapters/DeepSeekClient.js';

const enc = new TextEncoder();

async function* v3Fixture(): AsyncIterable<Uint8Array> {
  const lines = [
    'data: {"choices":[{"delta":{"reasoning_content":"think"}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"t1","function":{"name":"ls","arguments":"{\\"path\\":\\".\\"}"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"completion_tokens_details":{"reasoning_tokens":1}}}\n\n',
    'data: [DONE]\n\n',
  ];
  for (const l of lines) yield enc.encode(l);
}

async function* v4Fixture(): AsyncIterable<Uint8Array> {
  const lines = [
    'data: {"choices":[{"delta":{"reasoning_content":"think"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"<|DSML|tool_calls><call id=\\"t1\\" name=\\"ls\\"><param key=\\"path\\" string=\\"true\\">.</param></call></|DSML|tool_calls>"}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"completion_tokens_details":{"reasoning_tokens":1}}}\n\n',
    'data: [DONE]\n\n',
  ];
  for (const l of lines) yield enc.encode(l);
}

const req: ChatRequest = {
  model: 'm',
  messages: [{ role: 'user', content: 'list cwd' }],
  thinking: true,
  strict: true,
};

async function collect(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe('V3 / V4 adapter parity (R1)', () => {
  it('both emit the same canonical sequence of event types and same tool_call shape', async () => {
    const v3 = new V3Adapter({ apiKey: 'k', baseUrl: 'x', openSse: vi.fn().mockResolvedValue(v3Fixture()) });
    const v4 = new V4Adapter({ apiKey: 'k', baseUrl: 'x', openSse: vi.fn().mockResolvedValue(v4Fixture()) });
    const v3Events = await collect(v3.stream(req));
    const v4Events = await collect(v4.stream(req));
    expect(v3Events.map((e) => e.type)).toEqual(v4Events.map((e) => e.type));
    const v3Tool = v3Events.find((e) => e.type === 'tool_call');
    const v4Tool = v4Events.find((e) => e.type === 'tool_call');
    expect(v3Tool).toMatchObject({ name: 'ls', args: { path: '.' } });
    expect(v4Tool).toMatchObject({ name: 'ls', args: { path: '.' } });
  });
});
```

- [ ] **Step 2: Run to verify pass (validates R1 contract)**

```bash
pnpm test tests/unit/adapters/parity.test.ts
```

Expected: PASS — 1 test. If it fails, the adapters diverge on the canonical event contract; fix the offending adapter, not the test.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/adapters/parity.test.ts
git commit -m "test(adapters): cross-adapter parity contract enforcing R1"
```

---

## Phase 4 — Tool Registry & Schema

Tools are Zod-defined; JSON Schemas are generated, never hand-written (R3). Lightweight tools execute in-process; the bash tool dispatches to BullMQ (R6, Phase 5).

### Task 11: `schema.ts` — Zod → strict JSON Schema converter

**Files:**

- Create: `src/tools/schema.ts`
- Test: `tests/unit/tools/schema.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/tools/schema.test.ts
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { zodToStrictJsonSchema } from '../../../src/tools/schema.js';

describe('zodToStrictJsonSchema', () => {
  it('emits additionalProperties:false and lists every property in required (R3)', () => {
    const s = z.object({ path: z.string(), recursive: z.boolean() });
    const json = zodToStrictJsonSchema(s);
    expect(json).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['path', 'recursive'],
      properties: {
        path: { type: 'string' },
        recursive: { type: 'boolean' },
      },
    });
  });

  it('refuses optional fields (R3 forbids partial schemas)', () => {
    const s = z.object({ path: z.string(), recursive: z.boolean().optional() });
    expect(() => zodToStrictJsonSchema(s)).toThrow(/optional/i);
  });

  it('handles nested objects and arrays', () => {
    const s = z.object({ items: z.array(z.object({ name: z.string() })) });
    const json = zodToStrictJsonSchema(s) as { properties: { items: unknown } };
    expect(json.properties.items).toEqual({
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string' } } },
    });
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm test tests/unit/tools/schema.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `schema.ts`**

```ts
// src/tools/schema.ts
import { z } from 'zod';

export type JsonSchema =
  | { type: 'string' }
  | { type: 'number' }
  | { type: 'boolean' }
  | { type: 'array'; items: JsonSchema }
  | { type: 'object'; additionalProperties: false; required: string[]; properties: Record<string, JsonSchema> };

export function zodToStrictJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  return convert(schema);
}

function convert(schema: z.ZodTypeAny): JsonSchema {
  if (schema instanceof z.ZodOptional) {
    throw new Error('Strict-mode tool schemas (R3) forbid optional fields. Make the field required, or use a separate tool variant.');
  }
  if (schema instanceof z.ZodString) return { type: 'string' };
  if (schema instanceof z.ZodNumber) return { type: 'number' };
  if (schema instanceof z.ZodBoolean) return { type: 'boolean' };
  if (schema instanceof z.ZodArray) return { type: 'array', items: convert(schema.element as z.ZodTypeAny) };
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const [k, v] of Object.entries(shape)) {
      properties[k] = convert(v);
      required.push(k);
    }
    return { type: 'object', additionalProperties: false, required, properties };
  }
  throw new Error(`Unsupported Zod schema: ${schema.constructor.name}`);
}
```

- [ ] **Step 4: Run to verify pass**

```bash
pnpm test tests/unit/tools/schema.test.ts
```

Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/tools/schema.ts tests/unit/tools/schema.test.ts
git commit -m "feat(tools): Zod→JSON Schema converter enforcing strict-mode (R3)"
```

---

### Task 12: Tool registry with capability partitioning (R9)

**Files:**

- Create: `src/tools/registry.ts`
- Test: `tests/unit/tools/registry.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/tools/registry.test.ts
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from '../../../src/tools/registry.js';

describe('ToolRegistry', () => {
  it('registers a tool and exposes its V4-strict definition', () => {
    const r = new ToolRegistry();
    r.register({
      name: 'echo',
      description: 'Echo input',
      capability: 'execution',
      inputSchema: z.object({ msg: z.string() }),
      run: async ({ msg }) => msg,
    });
    const def = r.definitions()[0];
    expect(def?.name).toBe('echo');
    expect(def?.parameters).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['msg'],
      properties: { msg: { type: 'string' } },
    });
  });

  it('partitions tools by capability for mutual-exclusion enforcement (R9)', () => {
    const r = new ToolRegistry();
    r.register({ name: 'spawn', description: 'd', capability: 'coordination', inputSchema: z.object({ task: z.string() }), run: async () => 'ok' });
    r.register({ name: 'edit', description: 'd', capability: 'execution', inputSchema: z.object({ path: z.string() }), run: async () => 'ok' });
    expect(r.byCapability('coordination').map((t) => t.name)).toEqual(['spawn']);
    expect(r.byCapability('execution').map((t) => t.name)).toEqual(['edit']);
  });

  it('validates input via the registered Zod schema before invoking run', async () => {
    const r = new ToolRegistry();
    r.register({ name: 'echo', description: 'd', capability: 'execution', inputSchema: z.object({ msg: z.string() }), run: async ({ msg }) => msg });
    await expect(r.invoke('echo', { msg: 123 })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm test tests/unit/tools/registry.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `registry.ts`**

```ts
// src/tools/registry.ts
import type { z } from 'zod';
import type { ToolDefinition } from '../adapters/DeepSeekClient.js';
import { zodToStrictJsonSchema } from './schema.js';

export type Capability = 'coordination' | 'execution';

export type Tool<Input> = {
  name: string;
  description: string;
  capability: Capability;
  inputSchema: z.ZodType<Input>;
  run: (input: Input, ctx: ToolRunContext) => Promise<string>;
};

export type ToolRunContext = {
  cwd: string;
  abort: AbortSignal;
};

export class ToolRegistry {
  private readonly tools = new Map<string, Tool<unknown>>();

  register<I>(tool: Tool<I>): void {
    if (this.tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`);
    this.tools.set(tool.name, tool as Tool<unknown>);
  }

  definitions(): ToolDefinition[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      parameters: zodToStrictJsonSchema(t.inputSchema as unknown as z.ZodTypeAny),
    }));
  }

  byCapability(cap: Capability): Tool<unknown>[] {
    return [...this.tools.values()].filter((t) => t.capability === cap);
  }

  async invoke(name: string, rawInput: unknown, ctx?: Partial<ToolRunContext>): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    const parsed = tool.inputSchema.parse(rawInput);
    const fullCtx: ToolRunContext = { cwd: ctx?.cwd ?? process.cwd(), abort: ctx?.abort ?? new AbortController().signal };
    return tool.run(parsed, fullCtx);
  }
}
```

- [ ] **Step 4: Run to verify pass**

```bash
pnpm test tests/unit/tools/registry.test.ts
```

Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/tools/registry.ts tests/unit/tools/registry.test.ts
git commit -m "feat(tools): registry with capability partitioning (R9) and Zod validation"
```

---

### Task 13: Lightweight tools — readFile, writeFile, listDir, grep

**Files:**

- Create: `src/tools/readFile.ts`, `src/tools/writeFile.ts`, `src/tools/listDir.ts`, `src/tools/grep.ts`
- Test: `tests/unit/tools/lightweightTools.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/tools/lightweightTools.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { ToolRegistry } from '../../../src/tools/registry.js';
import { readFileTool } from '../../../src/tools/readFile.js';
import { writeFileTool } from '../../../src/tools/writeFile.js';
import { listDirTool } from '../../../src/tools/listDir.js';
import { grepTool } from '../../../src/tools/grep.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'myc-tools-'));
  await writeFile(join(tmp, 'a.txt'), 'hello world\nfoo bar\nhello again');
  await writeFile(join(tmp, 'b.txt'), 'nothing matches');
});
afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

describe('lightweight tools', () => {
  it('readFile returns the contents', async () => {
    const r = new ToolRegistry();
    r.register(readFileTool);
    const out = await r.invoke('read_file', { path: join(tmp, 'a.txt') });
    expect(out).toBe('hello world\nfoo bar\nhello again');
  });

  it('writeFile writes to disk', async () => {
    const r = new ToolRegistry();
    r.register(writeFileTool);
    await r.invoke('write_file', { path: join(tmp, 'c.txt'), content: 'new' });
    const r2 = new ToolRegistry();
    r2.register(readFileTool);
    expect(await r2.invoke('read_file', { path: join(tmp, 'c.txt') })).toBe('new');
  });

  it('listDir returns sorted entries', async () => {
    const r = new ToolRegistry();
    r.register(listDirTool);
    const out = await r.invoke('list_dir', { path: tmp });
    expect(out.split('\n').sort()).toEqual(['a.txt', 'b.txt']);
  });

  it('grep returns matching path:line:text triples', async () => {
    const r = new ToolRegistry();
    r.register(grepTool);
    const out = await r.invoke('grep', { pattern: 'hello', path: tmp });
    const lines = out.split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/a\.txt:1:hello world/);
    expect(lines[1]).toMatch(/a\.txt:3:hello again/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm test tests/unit/tools/lightweightTools.test.ts
```

Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the four tools**

```ts
// src/tools/readFile.ts
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { Tool } from './registry.js';

export const readFileTool: Tool<{ path: string }> = {
  name: 'read_file',
  description: 'Read the full contents of a UTF-8 text file at the given absolute path.',
  capability: 'execution',
  inputSchema: z.object({ path: z.string() }),
  run: async ({ path }) => readFile(path, 'utf8'),
};
```

```ts
// src/tools/writeFile.ts
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { Tool } from './registry.js';

export const writeFileTool: Tool<{ path: string; content: string }> = {
  name: 'write_file',
  description: 'Write content to a UTF-8 text file at the given absolute path. Creates parent directories.',
  capability: 'execution',
  inputSchema: z.object({ path: z.string(), content: z.string() }),
  run: async ({ path, content }) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, 'utf8');
    return `wrote ${content.length} bytes to ${path}`;
  },
};
```

```ts
// src/tools/listDir.ts
import { readdir } from 'node:fs/promises';
import { z } from 'zod';
import type { Tool } from './registry.js';

export const listDirTool: Tool<{ path: string }> = {
  name: 'list_dir',
  description: 'List entries in a directory, one per line.',
  capability: 'execution',
  inputSchema: z.object({ path: z.string() }),
  run: async ({ path }) => {
    const entries = await readdir(path);
    return entries.sort().join('\n');
  },
};
```

```ts
// src/tools/grep.ts
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { Tool } from './registry.js';

export const grepTool: Tool<{ pattern: string; path: string }> = {
  name: 'grep',
  description: 'Search files recursively under path for lines matching a regex. Returns path:lineNo:text per match.',
  capability: 'execution',
  inputSchema: z.object({ pattern: z.string(), path: z.string() }),
  run: async ({ pattern, path }) => {
    const re = new RegExp(pattern);
    const matches: string[] = [];
    await walk(path, async (filePath, relPath) => {
      const content = await readFile(filePath, 'utf8');
      content.split('\n').forEach((line, i) => {
        if (re.test(line)) matches.push(`${relPath}:${i + 1}:${line}`);
      });
    });
    return matches.join('\n');
  },
};

async function walk(root: string, visit: (filePath: string, relPath: string) => Promise<void>): Promise<void> {
  const queue: { abs: string; rel: string }[] = [{ abs: root, rel: '' }];
  while (queue.length > 0) {
    const { abs, rel } = queue.shift()!;
    const st = await stat(abs);
    if (st.isFile()) await visit(abs, rel || abs.split('/').pop() || abs);
    else if (st.isDirectory()) {
      const entries = await readdir(abs);
      for (const name of entries) queue.push({ abs: join(abs, name), rel: rel ? join(rel, name) : name });
    }
  }
}
```

- [ ] **Step 4: Run to verify pass**

```bash
pnpm test tests/unit/tools/lightweightTools.test.ts
```

Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/tools/readFile.ts src/tools/writeFile.ts src/tools/listDir.ts src/tools/grep.ts tests/unit/tools/lightweightTools.test.ts
git commit -m "feat(tools): in-process readFile/writeFile/listDir/grep"
```

---

## Phase 5 — BullMQ Background Tasks

Heavy I/O (bash, builds, tests) is dispatched to BullMQ jobs (R6). Worker uses `child_process.spawn` (never `exec`). Notification bridge feeds completed jobs back into the orchestrator's history.

### Task 14: Redis connection singleton

**Files:**

- Create: `src/queue/connection.ts`
- Test: `tests/unit/queue/connection.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/queue/connection.test.ts
import { describe, it, expect } from 'vitest';
import { redisConnectionOptions } from '../../../src/queue/connection.js';

describe('redisConnectionOptions', () => {
  it('parses REDIS_URL into ioredis-compatible options', () => {
    const opts = redisConnectionOptions('redis://localhost:6379');
    expect(opts).toMatchObject({ host: 'localhost', port: 6379, maxRetriesPerRequest: null });
  });

  it('honours auth in the URL', () => {
    const opts = redisConnectionOptions('redis://:secret@db.internal:6380');
    expect(opts).toMatchObject({ host: 'db.internal', port: 6380, password: 'secret' });
  });

  it('throws on missing scheme', () => {
    expect(() => redisConnectionOptions('localhost:6379')).toThrow(/scheme/i);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm test tests/unit/queue/connection.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `connection.ts`**

```ts
// src/queue/connection.ts
import IORedis, { type RedisOptions } from 'ioredis';

export function redisConnectionOptions(url: string): RedisOptions {
  if (!url.startsWith('redis://') && !url.startsWith('rediss://')) {
    throw new Error(`REDIS_URL must include a redis:// or rediss:// scheme; got: ${url}`);
  }
  const parsed = new URL(url);
  const opts: RedisOptions = {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 6379,
    // BullMQ requirement.
    maxRetriesPerRequest: null,
  };
  if (parsed.password) opts.password = parsed.password;
  if (parsed.username) opts.username = parsed.username;
  return opts;
}

let singleton: IORedis | null = null;

export function getRedis(url = process.env.REDIS_URL ?? 'redis://localhost:6379'): IORedis {
  if (!singleton) singleton = new IORedis(redisConnectionOptions(url));
  return singleton;
}

export async function closeRedis(): Promise<void> {
  if (singleton) {
    await singleton.quit();
    singleton = null;
  }
}
```

- [ ] **Step 4: Run to verify pass**

```bash
pnpm test tests/unit/queue/connection.test.ts
```

Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/queue/connection.ts tests/unit/queue/connection.test.ts
git commit -m "feat(queue): ioredis connection helper compatible with BullMQ"
```

---

### Task 15: Bash job (spawn-based, captures stdout/stderr)

**Files:**

- Create: `src/queue/jobs/bashJob.ts`
- Test: `tests/unit/queue/bashJob.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/queue/bashJob.test.ts
import { describe, it, expect } from 'vitest';
import { runBashJob, type BashJobInput } from '../../../src/queue/jobs/bashJob.js';

describe('runBashJob', () => {
  it('returns stdout and exit code for a successful command', async () => {
    const input: BashJobInput = { command: 'echo hello', cwd: process.cwd(), timeoutMs: 5000 };
    const result = await runBashJob(input);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello');
    expect(result.stderr).toBe('');
  });

  it('returns stderr and non-zero exit code for a failing command', async () => {
    const input: BashJobInput = { command: 'ls /this/path/does/not/exist', cwd: process.cwd(), timeoutMs: 5000 };
    const result = await runBashJob(input);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  it('truncates stdout if it exceeds maxBytes', async () => {
    const input: BashJobInput = { command: 'yes hi | head -c 200000', cwd: process.cwd(), timeoutMs: 5000, maxBytes: 1024 };
    const result = await runBashJob(input);
    expect(result.stdout.length).toBeLessThanOrEqual(1024 + 100); // small overshoot OK
    expect(result.truncated).toBe(true);
  });

  it('kills the process on timeout', async () => {
    const input: BashJobInput = { command: 'sleep 10', cwd: process.cwd(), timeoutMs: 200 };
    const result = await runBashJob(input);
    expect(result.timedOut).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm test tests/unit/queue/bashJob.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `bashJob.ts`**

```ts
// src/queue/jobs/bashJob.ts
import { spawn } from 'node:child_process';

export type BashJobInput = {
  command: string;
  cwd: string;
  timeoutMs: number;
  /** Default 1 MiB; output beyond is dropped and `truncated` is set. */
  maxBytes?: number;
};

export type BashJobResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
};

export function runBashJob(input: BashJobInput): Promise<BashJobResult> {
  const maxBytes = input.maxBytes ?? 1024 * 1024;
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', input.command], {
      cwd: input.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;

    const cap = (existing: string, chunk: Buffer): { next: string; truncated: boolean } => {
      if (existing.length >= maxBytes) return { next: existing, truncated: true };
      const remaining = maxBytes - existing.length;
      const piece = chunk.length > remaining ? chunk.subarray(0, remaining).toString('utf8') : chunk.toString('utf8');
      return { next: existing + piece, truncated: chunk.length > remaining };
    };

    child.stdout.on('data', (c: Buffer) => { const r = cap(stdout, c); stdout = r.next; if (r.truncated) truncated = true; });
    child.stderr.on('data', (c: Buffer) => { const r = cap(stderr, c); stderr = r.next; if (r.truncated) truncated = true; });

    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, input.timeoutMs);

    child.on('close', (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr, truncated, timedOut });
    });
  });
}
```

- [ ] **Step 4: Run to verify pass**

```bash
pnpm test tests/unit/queue/bashJob.test.ts
```

Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/queue/jobs/bashJob.ts tests/unit/queue/bashJob.test.ts
git commit -m "feat(queue/jobs): bash job using spawn with timeout, byte cap, stdio capture"
```

---

### Task 16: Queue definitions and notification bridge

**Files:**

- Create: `src/queue/queues.ts`, `src/queue/notifications.ts`
- Test: `tests/unit/queue/notifications.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/queue/notifications.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createNotificationBridge, type JobOutcome } from '../../../src/queue/notifications.js';

describe('createNotificationBridge', () => {
  it('forwards completed events to onCompleted with the job result', () => {
    const onCompleted = vi.fn();
    const bridge = createNotificationBridge({ onCompleted, onFailed: vi.fn() });
    const outcome: JobOutcome = { jobId: 'j1', toolUseId: 't1', queueName: 'bash', returnValue: { exitCode: 0, stdout: 'ok', stderr: '', truncated: false, timedOut: false } };
    bridge.emitCompleted(outcome);
    expect(onCompleted).toHaveBeenCalledWith(outcome);
  });

  it('forwards failed events to onFailed', () => {
    const onFailed = vi.fn();
    const bridge = createNotificationBridge({ onCompleted: vi.fn(), onFailed });
    bridge.emitFailed({ jobId: 'j1', toolUseId: 't1', queueName: 'bash', failedReason: 'oom' });
    expect(onFailed).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm test tests/unit/queue/notifications.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `queues.ts` and `notifications.ts`**

```ts
// src/queue/queues.ts
import { Queue } from 'bullmq';
import { getRedis } from './connection.js';
import type { BashJobInput, BashJobResult } from './jobs/bashJob.js';

export const QUEUE_NAMES = { bash: 'bash', test: 'test', docker: 'docker' } as const;
export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export type BashJobData = BashJobInput & { toolUseId: string };
export type BashJobReturn = BashJobResult;

export const bashQueue = (): Queue<BashJobData, BashJobReturn> =>
  new Queue<BashJobData, BashJobReturn>(QUEUE_NAMES.bash, {
    connection: getRedis(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 1000 },
    },
  });
```

```ts
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
```

- [ ] **Step 4: Run to verify pass**

```bash
pnpm test tests/unit/queue/notifications.test.ts
```

Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/queue/queues.ts src/queue/notifications.ts tests/unit/queue/notifications.test.ts
git commit -m "feat(queue): queue definitions and notification bridge"
```

---

### Task 17: Worker process — wires queue → bashJob → notification

**Files:**

- Create: `src/queue/worker.ts`

- [ ] **Step 1: Write the worker entry**

This is a standalone process (`pnpm queue:worker`). No unit test — integration test in Task 18 covers it via real Redis.

```ts
// src/queue/worker.ts
import { Worker, QueueEvents } from 'bullmq';
import { getRedis, closeRedis } from './connection.js';
import { runBashJob } from './jobs/bashJob.js';
import { QUEUE_NAMES, type BashJobData, type BashJobReturn } from './queues.js';

const worker = new Worker<BashJobData, BashJobReturn>(
  QUEUE_NAMES.bash,
  async (job) => runBashJob({
    command: job.data.command,
    cwd: job.data.cwd,
    timeoutMs: job.data.timeoutMs,
    ...(job.data.maxBytes !== undefined ? { maxBytes: job.data.maxBytes } : {}),
  }),
  { connection: getRedis(), concurrency: 4 },
);

const events = new QueueEvents(QUEUE_NAMES.bash, { connection: getRedis() });
events.on('completed', ({ jobId, returnvalue }) => {
  console.log(JSON.stringify({ event: 'completed', jobId, returnvalue }));
});
events.on('failed', ({ jobId, failedReason }) => {
  console.log(JSON.stringify({ event: 'failed', jobId, failedReason }));
});

const shutdown = async (): Promise<void> => {
  await worker.close();
  await events.close();
  await closeRedis();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log(`[worker] consuming queue: ${QUEUE_NAMES.bash} (concurrency=4)`);
```

- [ ] **Step 2: Verify the worker compiles and starts**

```bash
pnpm typecheck
pnpm redis:up
pnpm queue:worker &
WORKER_PID=$!
sleep 2
kill $WORKER_PID
```

Expected: typecheck passes; worker logs the consuming line; clean shutdown on SIGTERM.

- [ ] **Step 3: Commit**

```bash
git add src/queue/worker.ts
git commit -m "feat(queue): standalone bash queue worker entry"
```

---

### Task 18: Integration test — real Redis round-trip

**Files:**

- Test: `tests/integration/queueRoundTrip.test.ts`

- [ ] **Step 1: Write the integration test**

```ts
// tests/integration/queueRoundTrip.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Worker, QueueEvents } from 'bullmq';
import { getRedis, closeRedis } from '../../src/queue/connection.js';
import { bashQueue, QUEUE_NAMES, type BashJobData, type BashJobReturn } from '../../src/queue/queues.js';
import { runBashJob } from '../../src/queue/jobs/bashJob.js';

const skip = !process.env.REDIS_URL;
const d = skip ? describe.skip : describe;

d('queue round-trip (requires Redis)', () => {
  let worker: Worker<BashJobData, BashJobReturn>;
  let events: QueueEvents;

  beforeAll(() => {
    worker = new Worker<BashJobData, BashJobReturn>(
      QUEUE_NAMES.bash,
      async (job) => runBashJob({ command: job.data.command, cwd: job.data.cwd, timeoutMs: job.data.timeoutMs }),
      { connection: getRedis(), concurrency: 1 },
    );
    events = new QueueEvents(QUEUE_NAMES.bash, { connection: getRedis() });
  });

  afterAll(async () => {
    await worker.close();
    await events.close();
    await closeRedis();
  });

  it('enqueues a bash job and receives the result', async () => {
    const queue = bashQueue();
    const job = await queue.add('test-echo', {
      toolUseId: 'tu1',
      command: 'echo round-trip',
      cwd: process.cwd(),
      timeoutMs: 5000,
    });
    const result = await job.waitUntilFinished(events, 10_000);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('round-trip');
    await queue.close();
  });
});
```

- [ ] **Step 2: Bring up Redis and run**

```bash
pnpm redis:up
REDIS_URL=redis://localhost:6379 pnpm test:integration
```

Expected: PASS — 1 test (or skipped without `REDIS_URL`).

- [ ] **Step 3: Commit**

```bash
git add tests/integration/queueRoundTrip.test.ts
git commit -m "test(queue): integration round-trip with real Redis"
```

---

## Phase 6 — Memory Layer (OpenClaw pattern)

File-backed Markdown persistence under `.myceliate/`. No DB.

### Task 19: `MarkdownStore` — atomic file CRUD with frontmatter

**Files:**

- Create: `src/memory/markdownStore.ts`
- Test: `tests/unit/memory/markdownStore.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/memory/markdownStore.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MarkdownStore } from '../../../src/memory/markdownStore.js';

let tmp: string;
beforeEach(async () => { tmp = await mkdtemp(join(tmpdir(), 'myc-mem-')); });
afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

describe('MarkdownStore', () => {
  it('writes and reads back a record with frontmatter', async () => {
    const s = new MarkdownStore(tmp);
    await s.write('skills/grep.md', { title: 'Grep skill', tags: ['search'] }, 'Use grep for...');
    const read = await s.read('skills/grep.md');
    expect(read.frontmatter).toEqual({ title: 'Grep skill', tags: ['search'] });
    expect(read.body).toBe('Use grep for...');
  });

  it('appends to an existing file without rewriting frontmatter', async () => {
    const s = new MarkdownStore(tmp);
    await s.write('history/s1.md', { sessionId: 's1' }, '# turn 1\nhello');
    await s.append('history/s1.md', '\n\n# turn 2\nworld');
    const read = await s.read('history/s1.md');
    expect(read.body).toContain('# turn 1');
    expect(read.body).toContain('# turn 2\nworld');
  });

  it('lists records under a subdirectory', async () => {
    const s = new MarkdownStore(tmp);
    await s.write('skills/a.md', {}, 'a');
    await s.write('skills/b.md', {}, 'b');
    const ls = await s.list('skills');
    expect(ls.sort()).toEqual(['skills/a.md', 'skills/b.md']);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm test tests/unit/memory/markdownStore.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `markdownStore.ts`**

```ts
// src/memory/markdownStore.ts
import { mkdir, readFile, writeFile, appendFile, readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

export type Frontmatter = Record<string, unknown>;

export type Record = {
  frontmatter: Frontmatter;
  body: string;
};

export class MarkdownStore {
  constructor(private readonly root: string) {}

  async write(path: string, frontmatter: Frontmatter, body: string): Promise<void> {
    const abs = join(this.root, path);
    await mkdir(dirname(abs), { recursive: true });
    const fm = Object.keys(frontmatter).length === 0 ? '' : `---\n${serializeFrontmatter(frontmatter)}---\n`;
    await writeFile(abs, fm + body, 'utf8');
  }

  async append(path: string, additional: string): Promise<void> {
    const abs = join(this.root, path);
    await mkdir(dirname(abs), { recursive: true });
    await appendFile(abs, additional, 'utf8');
  }

  async read(path: string): Promise<Record> {
    const abs = join(this.root, path);
    const raw = await readFile(abs, 'utf8');
    return parseRecord(raw);
  }

  async list(subdir: string): Promise<string[]> {
    const abs = join(this.root, subdir);
    const out: string[] = [];
    const visit = async (dir: string): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isFile() && e.name.endsWith('.md')) out.push(relative(this.root, full));
        else if (e.isDirectory()) await visit(full);
      }
    };
    try { await visit(abs); } catch { /* missing dir → empty */ }
    return out;
  }
}

function serializeFrontmatter(fm: Frontmatter): string {
  return Object.entries(fm).map(([k, v]) => `${k}: ${JSON.stringify(v)}\n`).join('');
}

function parseRecord(raw: string): Record {
  if (!raw.startsWith('---\n')) return { frontmatter: {}, body: raw };
  const end = raw.indexOf('\n---\n', 4);
  if (end === -1) return { frontmatter: {}, body: raw };
  const fmText = raw.slice(4, end);
  const body = raw.slice(end + 5);
  const frontmatter: Frontmatter = {};
  for (const line of fmText.split('\n')) {
    if (!line.trim()) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const k = line.slice(0, colon).trim();
    const v = line.slice(colon + 1).trim();
    try { frontmatter[k] = JSON.parse(v); } catch { frontmatter[k] = v; }
  }
  return { frontmatter, body };
}
```

- [ ] **Step 4: Run to verify pass**

```bash
pnpm test tests/unit/memory/markdownStore.test.ts
```

Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/memory/markdownStore.ts tests/unit/memory/markdownStore.test.ts
git commit -m "feat(memory): file-backed Markdown store with frontmatter (OpenClaw pattern)"
```

---

### Task 20: `claudeMd.ts` and `conversationLog.ts` — typed loaders

**Files:**

- Create: `src/memory/claudeMd.ts`, `src/memory/conversationLog.ts`
- Test: `tests/unit/memory/loaders.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/memory/loaders.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProjectClaudeMd } from '../../../src/memory/claudeMd.js';
import { ConversationLog } from '../../../src/memory/conversationLog.js';
import { MarkdownStore } from '../../../src/memory/markdownStore.js';

let tmp: string;
beforeEach(async () => { tmp = await mkdtemp(join(tmpdir(), 'myc-load-')); });
afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

describe('memory loaders', () => {
  it('loadProjectClaudeMd returns the file contents when present', async () => {
    await writeFile(join(tmp, 'CLAUDE.md'), '# Constraints\nstrict TS', 'utf8');
    const text = await loadProjectClaudeMd(tmp);
    expect(text).toContain('strict TS');
  });

  it('loadProjectClaudeMd returns empty string when file is missing', async () => {
    const text = await loadProjectClaudeMd(tmp);
    expect(text).toBe('');
  });

  it('ConversationLog appends turn records under history/<session>.md', async () => {
    const store = new MarkdownStore(join(tmp, '.myceliate'));
    const log = new ConversationLog(store, 'sess-1');
    await log.appendTurn({ role: 'user', content: 'hi' });
    await log.appendTurn({ role: 'assistant', content: 'hello' });
    const rec = await store.read('history/sess-1.md');
    expect(rec.frontmatter.sessionId).toBe('sess-1');
    expect(rec.body).toContain('### user');
    expect(rec.body).toContain('### assistant');
    expect(rec.body).toContain('hi');
    expect(rec.body).toContain('hello');
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm test tests/unit/memory/loaders.test.ts
```

Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the loaders**

```ts
// src/memory/claudeMd.ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function loadProjectClaudeMd(cwd: string): Promise<string> {
  try {
    return await readFile(join(cwd, 'CLAUDE.md'), 'utf8');
  } catch {
    return '';
  }
}
```

```ts
// src/memory/conversationLog.ts
import type { Message } from '../adapters/messages.js';
import type { MarkdownStore } from './markdownStore.js';

export class ConversationLog {
  private initialized = false;
  constructor(private readonly store: MarkdownStore, private readonly sessionId: string) {}

  private path(): string { return `history/${this.sessionId}.md`; }

  async appendTurn(message: Message): Promise<void> {
    if (!this.initialized) {
      await this.store.write(this.path(), { sessionId: this.sessionId, started: new Date().toISOString() }, '');
      this.initialized = true;
    }
    const block = renderTurn(message);
    await this.store.append(this.path(), block);
  }
}

function renderTurn(m: Message): string {
  switch (m.role) {
    case 'system':
    case 'user':
    case 'assistant': {
      const reasoning = m.role === 'assistant' && m.reasoning_content ? `\n<details><summary>reasoning</summary>\n\n${m.reasoning_content}\n\n</details>\n` : '';
      const tools = m.role === 'assistant' && m.tool_calls?.length ? `\n\n**tool_calls:** ${m.tool_calls.map((tc) => `${tc.name}(${JSON.stringify(tc.args)})`).join(', ')}\n` : '';
      return `\n\n### ${m.role}\n\n${m.content}${reasoning}${tools}`;
    }
    case 'tool':
      return `\n\n### tool (${m.result.tool_use_id}) ${m.result.is_error ? 'ERROR' : 'OK'}\n\n\`\`\`\n${m.result.content}\n\`\`\``;
  }
}
```

- [ ] **Step 4: Run to verify pass**

```bash
pnpm test tests/unit/memory/loaders.test.ts
```

Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/memory/claudeMd.ts src/memory/conversationLog.ts tests/unit/memory/loaders.test.ts
git commit -m "feat(memory): CLAUDE.md loader and per-session ConversationLog"
```

---

## Phase 7 — Security (Egress redaction + HITL gate)

### Task 21: Secret redactor

**Files:**

- Create: `src/security/redactor.ts`
- Test: `tests/unit/security/redactor.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/security/redactor.test.ts
import { describe, it, expect } from 'vitest';
import { redactSecrets } from '../../../src/security/redactor.js';

describe('redactSecrets', () => {
  it('redacts OpenAI/Anthropic-style API keys', () => {
    const out = redactSecrets('key=sk-proj-abc123def456ghi789jklmnopqrstuvwxyzabc and sk-ant-api03-token12345678901234567890');
    expect(out).not.toContain('sk-proj-abc');
    expect(out).not.toContain('sk-ant-api03');
    expect(out).toContain('[REDACTED:openai_key]');
    expect(out).toContain('[REDACTED:anthropic_key]');
  });

  it('redacts JWT tokens', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const out = redactSecrets(`token: ${jwt}`);
    expect(out).toContain('[REDACTED:jwt]');
    expect(out).not.toContain(jwt);
  });

  it('redacts PEM blocks', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKc...\n-----END PRIVATE KEY-----';
    const out = redactSecrets(pem);
    expect(out).toContain('[REDACTED:pem]');
    expect(out).not.toContain('MIIEvQIBADAN');
  });

  it('redacts dotenv-style assignments for known sensitive keys', () => {
    const out = redactSecrets('DATABASE_URL=postgres://user:pass@host/db\nAPI_KEY=topsecret123');
    expect(out).toContain('[REDACTED:env_value]');
    expect(out).not.toContain('topsecret123');
    expect(out).not.toContain('pass@host');
  });

  it('leaves benign text untouched', () => {
    expect(redactSecrets('Just a normal sentence.')).toBe('Just a normal sentence.');
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm test tests/unit/security/redactor.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `redactor.ts`**

```ts
// src/security/redactor.ts
type Pattern = { kind: string; re: RegExp };

const PATTERNS: Pattern[] = [
  { kind: 'openai_key', re: /sk-(?:proj|live|test)?-?[A-Za-z0-9_-]{20,}/g },
  { kind: 'anthropic_key', re: /sk-ant-[a-z0-9-]+-[A-Za-z0-9_-]{20,}/g },
  { kind: 'jwt', re: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g },
  { kind: 'pem', re: /-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g },
  { kind: 'env_value', re: /\b(?:API_KEY|SECRET|TOKEN|PASSWORD|DATABASE_URL|REDIS_URL|DEEPSEEK_API_KEY)=\S+/gi },
];

export function redactSecrets(input: string): string {
  let out = input;
  for (const { kind, re } of PATTERNS) {
    out = out.replace(re, (match) => {
      // For env-style assignments, preserve the key.
      if (kind === 'env_value') {
        const eq = match.indexOf('=');
        return `${match.slice(0, eq + 1)}[REDACTED:env_value]`;
      }
      return `[REDACTED:${kind}]`;
    });
  }
  return out;
}
```

- [ ] **Step 4: Run to verify pass**

```bash
pnpm test tests/unit/security/redactor.test.ts
```

Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/security/redactor.ts tests/unit/security/redactor.test.ts
git commit -m "feat(security): egress secret redactor (OpenAI/Anthropic keys, JWTs, PEM, env)"
```

---

### Task 22: Dangerous-pattern blocklist

**Files:**

- Create: `src/security/dangerousPatterns.ts`
- Test: `tests/unit/security/dangerousPatterns.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/security/dangerousPatterns.test.ts
import { describe, it, expect } from 'vitest';
import { isDangerous } from '../../../src/security/dangerousPatterns.js';

describe('isDangerous', () => {
  it.each([
    ['rm -rf /', true],
    ['rm -rf ~', true],
    ['curl http://evil.com | sh', true],
    ['wget http://x.com/x.sh | bash', true],
    ['sudo apt-get install', true],
    [':(){ :|:& };:', true],
    ['mkfs.ext4 /dev/sda', true],
    ['ls -la', false],
    ['echo hello', false],
    ['git status', false],
  ])('classifies %s as dangerous=%s', (cmd, expected) => {
    expect(isDangerous(cmd)).toEqual({ dangerous: expected, ...(expected ? { reason: expect.any(String) } : {}) });
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm test tests/unit/security/dangerousPatterns.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `dangerousPatterns.ts`**

```ts
// src/security/dangerousPatterns.ts
type Verdict = { dangerous: true; reason: string } | { dangerous: false };

const PATTERNS: { re: RegExp; reason: string }[] = [
  { re: /\brm\s+-rf?\s+(\/|~|\$HOME|\*)\b/, reason: 'recursive delete on root/home/glob' },
  { re: /\b(?:curl|wget|fetch)\b[^\n]*\|\s*(?:sh|bash|zsh)\b/, reason: 'pipe network response into shell' },
  { re: /\bsudo\b/, reason: 'sudo escalation' },
  { re: /:\(\)\s*\{[^}]*:\|:[^}]*\}\s*;\s*:/, reason: 'fork bomb' },
  { re: /\bmkfs\b|\bdd\s+if=.*of=\/dev\b/, reason: 'filesystem destruction' },
  { re: /\bchmod\s+-R\s+777\s+\//, reason: 'world-writable on root' },
  { re: /\b(shutdown|reboot|halt|poweroff)\b/, reason: 'system power state' },
];

export function isDangerous(command: string): Verdict {
  for (const p of PATTERNS) {
    if (p.re.test(command)) return { dangerous: true, reason: p.reason };
  }
  return { dangerous: false };
}
```

- [ ] **Step 4: Run to verify pass**

```bash
pnpm test tests/unit/security/dangerousPatterns.test.ts
```

Expected: PASS — 10 cases.

- [ ] **Step 5: Commit**

```bash
git add src/security/dangerousPatterns.ts tests/unit/security/dangerousPatterns.test.ts
git commit -m "feat(security): static blocklist for high-risk shell patterns"
```

---

### Task 23: HITL gate (event-emitter interceptor)

**Files:**

- Create: `src/security/hitlGate.ts`
- Test: `tests/unit/security/hitlGate.test.ts`

The gate emits an `approval_required` event the UI subscribes to; the user's response resolves a per-request promise. Tests use a stub UI that auto-approves.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/security/hitlGate.test.ts
import { describe, it, expect, vi } from 'vitest';
import { HitlGate } from '../../../src/security/hitlGate.js';

describe('HitlGate', () => {
  it('passes through commands deemed safe by isDangerous', async () => {
    const gate = new HitlGate({ requestApproval: vi.fn() });
    const verdict = await gate.checkBash({ command: 'ls -la', cwd: process.cwd() });
    expect(verdict.allowed).toBe(true);
    expect(verdict.requiredApproval).toBe(false);
  });

  it('routes dangerous commands to requestApproval and respects approve', async () => {
    const requestApproval = vi.fn().mockResolvedValue({ decision: 'approve' });
    const gate = new HitlGate({ requestApproval });
    const verdict = await gate.checkBash({ command: 'rm -rf /tmp/foo/', cwd: process.cwd() });
    expect(verdict.allowed).toBe(true);
    expect(verdict.requiredApproval).toBe(true);
    expect(requestApproval).toHaveBeenCalled();
  });

  it('blocks when user rejects', async () => {
    const requestApproval = vi.fn().mockResolvedValue({ decision: 'reject', feedback: 'too broad' });
    const gate = new HitlGate({ requestApproval });
    const verdict = await gate.checkBash({ command: 'sudo rm -rf ~', cwd: process.cwd() });
    expect(verdict.allowed).toBe(false);
    expect(verdict.feedback).toBe('too broad');
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm test tests/unit/security/hitlGate.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `hitlGate.ts`**

```ts
// src/security/hitlGate.ts
import { isDangerous } from './dangerousPatterns.js';

export type ApprovalRequest = {
  command: string;
  cwd: string;
  reason: string;
};

export type ApprovalResponse = { decision: 'approve' | 'reject'; feedback?: string };

export type ApprovalRequester = (req: ApprovalRequest) => Promise<ApprovalResponse>;

export type BashCheck = { command: string; cwd: string };

export type Verdict =
  | { allowed: true; requiredApproval: boolean }
  | { allowed: false; requiredApproval: true; feedback: string };

export class HitlGate {
  constructor(private readonly opts: { requestApproval: ApprovalRequester }) {}

  async checkBash(input: BashCheck): Promise<Verdict> {
    const v = isDangerous(input.command);
    if (!v.dangerous) return { allowed: true, requiredApproval: false };
    const response = await this.opts.requestApproval({
      command: input.command,
      cwd: input.cwd,
      reason: v.reason,
    });
    if (response.decision === 'approve') return { allowed: true, requiredApproval: true };
    return { allowed: false, requiredApproval: true, feedback: response.feedback ?? 'rejected without feedback' };
  }
}
```

- [ ] **Step 4: Run to verify pass**

```bash
pnpm test tests/unit/security/hitlGate.test.ts
```

Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/security/hitlGate.ts tests/unit/security/hitlGate.test.ts
git commit -m "feat(security): HITL gate routing dangerous bash through approval requester"
```

---

## Phase 8 — Compaction (Layers 1–3)

Layers 4 (ACE) and 5 (auto-compaction) are deferred to v2 per CLAUDE.md.

### Task 24: Token estimator (coarse)

**Files:**

- Create: `src/util/tokens.ts`
- Test: `tests/unit/util/tokens.test.ts`

We don't ship a real tokenizer in v1; coarse estimates (chars / 4) are sufficient for budget gating.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/util/tokens.test.ts
import { describe, it, expect } from 'vitest';
import { estimateTokens, estimateMessageTokens } from '../../../src/util/tokens.js';

describe('token estimator (coarse)', () => {
  it('estimates ~chars/4 for plain text', () => {
    expect(estimateTokens('hello world')).toBe(Math.ceil('hello world'.length / 4));
  });

  it('estimates assistant message including reasoning_content and tool_calls JSON', () => {
    const t = estimateMessageTokens({ role: 'assistant', content: 'ok', reasoning_content: 'thinking…', tool_calls: [{ id: 't', name: 'x', args: { a: 1 } }] });
    expect(t).toBeGreaterThan(estimateTokens('ok'));
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm test tests/unit/util/tokens.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `tokens.ts`**

```ts
// src/util/tokens.ts
import type { Message } from '../adapters/messages.js';

const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateMessageTokens(m: Message): number {
  switch (m.role) {
    case 'system':
    case 'user':
      return estimateTokens(m.content) + 4;
    case 'assistant': {
      let n = estimateTokens(m.content) + 4;
      if (m.reasoning_content) n += estimateTokens(m.reasoning_content);
      if (m.tool_calls) n += estimateTokens(JSON.stringify(m.tool_calls));
      return n;
    }
    case 'tool':
      return estimateTokens(m.result.content) + estimateTokens(m.result.command) + 8;
  }
}

export function estimateHistoryTokens(msgs: readonly Message[]): number {
  return msgs.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
}
```

- [ ] **Step 4: Run to verify pass**

```bash
pnpm test tests/unit/util/tokens.test.ts
```

Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/util/tokens.ts tests/unit/util/tokens.test.ts
git commit -m "feat(util): coarse token estimator for budget gating"
```

---

### Task 25: BudgetChecker

**Files:**

- Create: `src/orchestrator/compaction/budgetChecker.ts`
- Test: `tests/unit/compaction/budgetChecker.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/compaction/budgetChecker.test.ts
import { describe, it, expect } from 'vitest';
import { BudgetChecker } from '../../../src/orchestrator/compaction/budgetChecker.js';
import type { Message } from '../../../src/adapters/messages.js';

const big = (n: number): Message => ({ role: 'user', content: 'x'.repeat(n) });

describe('BudgetChecker', () => {
  it('reports under-budget when below threshold', () => {
    const c = new BudgetChecker({ workingBudget: 1000, pruneThresholdPct: 80, snipThresholdPct: 85, microThresholdPct: 90, refusalThresholdPct: 95 });
    const verdict = c.check([big(100)]);
    expect(verdict.action).toBe('none');
  });

  it('triggers prune at >= prune threshold', () => {
    const c = new BudgetChecker({ workingBudget: 100, pruneThresholdPct: 80, snipThresholdPct: 85, microThresholdPct: 90, refusalThresholdPct: 95 });
    expect(c.check([big(320)]).action).toBe('prune');
  });

  it('escalates to snip then micro then refuse', () => {
    const c = new BudgetChecker({ workingBudget: 100, pruneThresholdPct: 80, snipThresholdPct: 85, microThresholdPct: 90, refusalThresholdPct: 95 });
    expect(c.check([big(340)]).action).toBe('snip');
    expect(c.check([big(360)]).action).toBe('micro');
    expect(c.check([big(400)]).action).toBe('refuse');
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm test tests/unit/compaction/budgetChecker.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `budgetChecker.ts`**

```ts
// src/orchestrator/compaction/budgetChecker.ts
import type { Message } from '../../adapters/messages.js';
import { estimateHistoryTokens } from '../../util/tokens.js';

export type BudgetThresholds = {
  workingBudget: number;
  pruneThresholdPct: number;
  snipThresholdPct: number;
  microThresholdPct: number;
  refusalThresholdPct: number;
};

export type BudgetVerdict = {
  used: number;
  pct: number;
  action: 'none' | 'prune' | 'snip' | 'micro' | 'refuse';
};

export class BudgetChecker {
  constructor(private readonly t: BudgetThresholds) {}

  check(history: readonly Message[]): BudgetVerdict {
    const used = estimateHistoryTokens(history);
    const pct = (used / this.t.workingBudget) * 100;
    let action: BudgetVerdict['action'] = 'none';
    if (pct >= this.t.refusalThresholdPct) action = 'refuse';
    else if (pct >= this.t.microThresholdPct) action = 'micro';
    else if (pct >= this.t.snipThresholdPct) action = 'snip';
    else if (pct >= this.t.pruneThresholdPct) action = 'prune';
    return { used, pct, action };
  }
}
```

- [ ] **Step 4: Run to verify pass**

```bash
pnpm test tests/unit/compaction/budgetChecker.test.ts
```

Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/compaction/budgetChecker.ts tests/unit/compaction/budgetChecker.test.ts
git commit -m "feat(compaction): budget checker with 4-tier action ladder"
```

---

### Task 26: Tool output pruner (Layer 1)

**Files:**

- Create: `src/orchestrator/compaction/toolOutputPruner.ts`
- Test: `tests/unit/compaction/toolOutputPruner.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/compaction/toolOutputPruner.test.ts
import { describe, it, expect } from 'vitest';
import { pruneToolOutputs } from '../../../src/orchestrator/compaction/toolOutputPruner.js';
import type { Message } from '../../../src/adapters/messages.js';

const tool = (id: string, command: string, content: string): Message => ({
  role: 'tool',
  result: { tool_use_id: id, command, is_error: false, content },
});

describe('pruneToolOutputs', () => {
  it('truncates oversized tool result content but preserves metadata', () => {
    const big = 'x'.repeat(50_000);
    const history: Message[] = [{ role: 'user', content: 'go' }, tool('t1', 'cat huge.log', big)];
    const out = pruneToolOutputs(history, { maxToolOutputChars: 1000, protectedTailMessages: 0 });
    const pruned = out[1];
    if (pruned?.role !== 'tool') throw new Error('not tool');
    expect(pruned.result.content.length).toBeLessThan(big.length);
    expect(pruned.result.content).toContain('[truncated');
    expect(pruned.result.command).toBe('cat huge.log');
  });

  it('does not touch tool results within the protected tail', () => {
    const big = 'x'.repeat(50_000);
    const history: Message[] = [tool('t1', 'cmd', big)];
    const out = pruneToolOutputs(history, { maxToolOutputChars: 1000, protectedTailMessages: 5 });
    expect((out[0] as Extract<Message, { role: 'tool' }>).result.content).toBe(big);
  });

  it('deduplicates identical read_file results, keeping the most recent', () => {
    const history: Message[] = [
      tool('t1', 'read_file a.txt', 'contents-A-v1'),
      { role: 'assistant', content: 'thinking' },
      tool('t2', 'read_file a.txt', 'contents-A-v2'),
    ];
    const out = pruneToolOutputs(history, { maxToolOutputChars: 100_000, protectedTailMessages: 0 });
    const tools = out.filter((m): m is Extract<Message, { role: 'tool' }> => m.role === 'tool');
    expect(tools).toHaveLength(1);
    expect(tools[0]!.result.content).toBe('contents-A-v2');
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm test tests/unit/compaction/toolOutputPruner.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `toolOutputPruner.ts`**

```ts
// src/orchestrator/compaction/toolOutputPruner.ts
import type { Message, ToolResultMessage } from '../../adapters/messages.js';

export type PruneOptions = {
  maxToolOutputChars: number;
  /** Most recent N messages are immune to pruning. */
  protectedTailMessages: number;
};

export function pruneToolOutputs(history: readonly Message[], opts: PruneOptions): Message[] {
  const protectedFrom = Math.max(0, history.length - opts.protectedTailMessages);
  const seenReads = new Map<string, number>();

  // First pass: index latest read_file results so we can drop earlier ones.
  history.forEach((m, i) => {
    if (m.role === 'tool' && m.result.command.startsWith('read_file')) {
      seenReads.set(m.result.command, i);
    }
  });

  const out: Message[] = [];
  history.forEach((m, i) => {
    if (m.role === 'tool') {
      // Dedup: drop earlier read_file results.
      if (m.result.command.startsWith('read_file') && seenReads.get(m.result.command) !== i) {
        return;
      }
      // Truncate oversized.
      if (i < protectedFrom && m.result.content.length > opts.maxToolOutputChars) {
        const truncated: ToolResultMessage = {
          role: 'tool',
          result: {
            ...m.result,
            content: `${m.result.content.slice(0, opts.maxToolOutputChars)}\n\n[truncated: original ${m.result.content.length} chars]`,
          },
        };
        out.push(truncated);
        return;
      }
    }
    out.push(m);
  });
  return out;
}
```

- [ ] **Step 4: Run to verify pass**

```bash
pnpm test tests/unit/compaction/toolOutputPruner.test.ts
```

Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/compaction/toolOutputPruner.ts tests/unit/compaction/toolOutputPruner.test.ts
git commit -m "feat(compaction): layer 1 tool output pruner with dedup + tail protection"
```

---

### Task 27: History snipper (Layer 2)

**Files:**

- Create: `src/orchestrator/compaction/snipper.ts`
- Test: `tests/unit/compaction/snipper.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/compaction/snipper.test.ts
import { describe, it, expect } from 'vitest';
import { snipDeadEnds } from '../../../src/orchestrator/compaction/snipper.js';
import type { Message } from '../../../src/adapters/messages.js';

const u = (s: string): Message => ({ role: 'user', content: s });
const a = (s: string): Message => ({ role: 'assistant', content: s });
const errTool = (id: string): Message => ({ role: 'tool', result: { tool_use_id: id, command: 'cmd', is_error: true, content: 'err' } });
const okTool = (id: string): Message => ({ role: 'tool', result: { tool_use_id: id, command: 'cmd', is_error: false, content: 'ok' } });

describe('snipDeadEnds', () => {
  it('protects the system message and the most recent N tokens', () => {
    const history: Message[] = [
      { role: 'system', content: 'rules' },
      u('first'),
      errTool('t1'), errTool('t2'), errTool('t3'),
      a('giving up on that approach'),
      u('latest'),
    ];
    const out = snipDeadEnds(history, { protectedTailTokens: 1000 });
    expect(out[0]?.role).toBe('system');
    expect(out.at(-1)).toEqual(u('latest'));
  });

  it('removes runs of >= 3 consecutive errored tool results from the middle', () => {
    const history: Message[] = [
      u('start'),
      errTool('t1'), errTool('t2'), errTool('t3'), errTool('t4'),
      a('switching strategy'),
      okTool('t5'),
      u('done'),
    ];
    const out = snipDeadEnds(history, { protectedTailTokens: 50 });
    const errors = out.filter((m) => m.role === 'tool' && m.result.is_error);
    expect(errors.length).toBeLessThan(4);
  });

  it('never snips messages within the protected tail', () => {
    const history: Message[] = [
      u('start'),
      errTool('t1'), errTool('t2'), errTool('t3'),
      u('latest'),
    ];
    // Set protectedTailTokens huge so the whole history is protected.
    const out = snipDeadEnds(history, { protectedTailTokens: 100_000 });
    expect(out).toEqual(history);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm test tests/unit/compaction/snipper.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `snipper.ts`**

```ts
// src/orchestrator/compaction/snipper.ts
import type { Message } from '../../adapters/messages.js';
import { estimateMessageTokens } from '../../util/tokens.js';

export type SnipOptions = { protectedTailTokens: number };

export function snipDeadEnds(history: readonly Message[], opts: SnipOptions): Message[] {
  const protectedFrom = computeProtectedStart(history, opts.protectedTailTokens);
  const result: Message[] = [];
  let i = 0;
  while (i < history.length) {
    const m = history[i]!;
    // Always preserve system messages and the protected tail.
    if (m.role === 'system' || i >= protectedFrom) {
      result.push(m);
      i++;
      continue;
    }
    // Detect error runs of 3+ consecutive failing tool results in the unprotected zone.
    if (m.role === 'tool' && m.result.is_error) {
      let runEnd = i;
      while (runEnd < history.length) {
        const n = history[runEnd]!;
        if (n.role === 'tool' && n.result.is_error && runEnd < protectedFrom) runEnd++;
        else break;
      }
      const runLen = runEnd - i;
      if (runLen >= 3) {
        // Replace the dead-end run with a single marker note.
        result.push({
          role: 'system',
          content: `[snipped ${runLen} consecutive failed tool calls — abandoned trajectory]`,
        });
        i = runEnd;
        continue;
      }
    }
    result.push(m);
    i++;
  }
  return result;
}

function computeProtectedStart(history: readonly Message[], protectedTailTokens: number): number {
  let acc = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    acc += estimateMessageTokens(history[i]!);
    if (acc >= protectedTailTokens) return i;
  }
  return 0;
}
```

- [ ] **Step 4: Run to verify pass**

```bash
pnpm test tests/unit/compaction/snipper.test.ts
```

Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/compaction/snipper.ts tests/unit/compaction/snipper.test.ts
git commit -m "feat(compaction): layer 2 snipper for abandoned error runs"
```

---

### Task 28: Cache-aware micro-compactor (Layer 3)

**Files:**

- Create: `src/orchestrator/compaction/microCompactor.ts`
- Test: `tests/unit/compaction/microCompactor.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/compaction/microCompactor.test.ts
import { describe, it, expect } from 'vitest';
import { microCompact } from '../../../src/orchestrator/compaction/microCompactor.js';
import type { Message } from '../../../src/adapters/messages.js';

const tool = (id: string, command: string, content: string, isError = false): Message => ({
  role: 'tool',
  result: { tool_use_id: id, command, is_error: isError, content },
});

describe('microCompact', () => {
  it('clears tool result content but preserves tool_use_id, command, is_error', () => {
    const history: Message[] = [
      tool('t1', 'bash echo a', 'aaaaaaaaaaaaaaa'.repeat(100)),
      { role: 'assistant', content: 'next' },
    ];
    const out = microCompact(history, { protectedTailMessages: 0 });
    const collapsed = out[0];
    if (collapsed?.role !== 'tool') throw new Error('expected tool');
    expect(collapsed.result.tool_use_id).toBe('t1');
    expect(collapsed.result.command).toBe('bash echo a');
    expect(collapsed.result.is_error).toBe(false);
    expect(collapsed.result.content).toBe('[micro-compacted]');
  });

  it('preserves error status verbatim while still clearing content', () => {
    const out = microCompact([tool('t1', 'cmd', 'fail trace', true)], { protectedTailMessages: 0 });
    expect((out[0] as Extract<Message, { role: 'tool' }>).result.is_error).toBe(true);
    expect((out[0] as Extract<Message, { role: 'tool' }>).result.content).toBe('[micro-compacted]');
  });

  it('does not touch tool results in the protected tail', () => {
    const history: Message[] = [tool('t1', 'cmd', 'keep me')];
    const out = microCompact(history, { protectedTailMessages: 5 });
    expect((out[0] as Extract<Message, { role: 'tool' }>).result.content).toBe('keep me');
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm test tests/unit/compaction/microCompactor.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `microCompactor.ts`**

```ts
// src/orchestrator/compaction/microCompactor.ts
import type { Message } from '../../adapters/messages.js';

export type MicroOptions = { protectedTailMessages: number };

export function microCompact(history: readonly Message[], opts: MicroOptions): Message[] {
  const protectedFrom = Math.max(0, history.length - opts.protectedTailMessages);
  return history.map((m, i) => {
    if (m.role === 'tool' && i < protectedFrom) {
      return {
        role: 'tool',
        result: {
          tool_use_id: m.result.tool_use_id,
          command: m.result.command,
          is_error: m.result.is_error,
          content: '[micro-compacted]',
        },
      } as const;
    }
    return m;
  });
}
```

- [ ] **Step 4: Run to verify pass**

```bash
pnpm test tests/unit/compaction/microCompactor.test.ts
```

Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/compaction/microCompactor.ts tests/unit/compaction/microCompactor.test.ts
git commit -m "feat(compaction): layer 3 cache-aware micro-compactor (metadata-only)"
```

---

## Phase 9 — Orchestrator (context, QueryEngine, ReAct loop)

### Task 29: `context.ts` — environment sensing at session start

**Files:**

- Create: `src/orchestrator/context.ts`
- Test: `tests/unit/orchestrator/context.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/orchestrator/context.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { senseContext } from '../../../src/orchestrator/context.js';

let tmp: string;
beforeEach(async () => { tmp = await mkdtemp(join(tmpdir(), 'myc-ctx-')); });
afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

describe('senseContext', () => {
  it('captures cwd, claudeMd, and memory dir', async () => {
    await writeFile(join(tmp, 'CLAUDE.md'), '# rules', 'utf8');
    await mkdir(join(tmp, '.myceliate'), { recursive: true });
    const ctx = await senseContext({ cwd: tmp });
    expect(ctx.cwd).toBe(tmp);
    expect(ctx.claudeMd).toBe('# rules');
    expect(ctx.memoryDir).toBe(join(tmp, '.myceliate'));
  });

  it('handles missing CLAUDE.md gracefully', async () => {
    const ctx = await senseContext({ cwd: tmp });
    expect(ctx.claudeMd).toBe('');
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm test tests/unit/orchestrator/context.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `context.ts`**

```ts
// src/orchestrator/context.ts
import { join } from 'node:path';
import { loadProjectClaudeMd } from '../memory/claudeMd.js';

export type SessionContext = {
  cwd: string;
  claudeMd: string;
  memoryDir: string;
};

export async function senseContext(opts: { cwd: string; memoryDirName?: string }): Promise<SessionContext> {
  const memoryDir = join(opts.cwd, opts.memoryDirName ?? '.myceliate');
  const claudeMd = await loadProjectClaudeMd(opts.cwd);
  return { cwd: opts.cwd, claudeMd, memoryDir };
}
```

- [ ] **Step 4: Run to verify pass**

```bash
pnpm test tests/unit/orchestrator/context.test.ts
```

Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/context.ts tests/unit/orchestrator/context.test.ts
git commit -m "feat(orchestrator): senseContext loads cwd/CLAUDE.md/memory dir"
```

---

### Task 30: `QueryEngine` — owns history, applies compaction, enforces R2

**Files:**

- Create: `src/orchestrator/QueryEngine.ts`
- Test: `tests/unit/orchestrator/QueryEngine.test.ts`

The QueryEngine wraps message history with R2 (reasoning_content retention only when tool_calls present), applies compaction layers in order when budget thresholds trip, and exposes `prepareRequest()` for the ReAct loop.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/orchestrator/QueryEngine.test.ts
import { describe, it, expect } from 'vitest';
import { QueryEngine } from '../../../src/orchestrator/QueryEngine.js';
import type { Message } from '../../../src/adapters/messages.js';

const t = (id: string, content: string): Message => ({ role: 'tool', result: { tool_use_id: id, command: 'cmd', is_error: false, content } });

describe('QueryEngine', () => {
  it('appends and exposes the history', () => {
    const q = new QueryEngine({ systemPrompt: 'sys', workingBudget: 10_000 });
    q.appendUser('hi');
    const req = q.prepareRequest({ model: 'm', tools: [], thinking: true, strict: true });
    expect(req.messages[0]).toEqual({ role: 'system', content: 'sys' });
    expect(req.messages.at(-1)).toEqual({ role: 'user', content: 'hi' });
  });

  it('R2: retains reasoning_content on assistant turns that include tool_calls', () => {
    const q = new QueryEngine({ systemPrompt: 'sys', workingBudget: 10_000 });
    q.appendAssistant({ content: '', reasoning_content: 'I should call a tool', tool_calls: [{ id: 't1', name: 'x', args: {} }] });
    q.appendToolResult({ tool_use_id: 't1', command: 'cmd', is_error: false, content: 'ok' });
    const req = q.prepareRequest({ model: 'm', tools: [], thinking: true, strict: true });
    const asst = req.messages.find((m) => m.role === 'assistant');
    expect(asst).toMatchObject({ reasoning_content: 'I should call a tool' });
  });

  it('R2: discards reasoning_content from purely conversational assistant turns', () => {
    const q = new QueryEngine({ systemPrompt: 'sys', workingBudget: 10_000 });
    q.appendAssistant({ content: 'final answer', reasoning_content: 'noise' });
    const req = q.prepareRequest({ model: 'm', tools: [], thinking: true, strict: true });
    const asst = req.messages.find((m) => m.role === 'assistant');
    expect(asst).not.toHaveProperty('reasoning_content');
  });

  it('runs compaction when budget exceeds prune threshold', () => {
    const q = new QueryEngine({
      systemPrompt: 'sys',
      workingBudget: 200,
      thresholds: { pruneThresholdPct: 50, snipThresholdPct: 70, microThresholdPct: 90, refusalThresholdPct: 95 },
    });
    q.appendToolResult({ tool_use_id: 't', command: 'read_file big.log', is_error: false, content: 'x'.repeat(10_000) });
    q.appendUser('continue');
    const req = q.prepareRequest({ model: 'm', tools: [], thinking: true, strict: true });
    const tool = req.messages.find((m) => m.role === 'tool');
    if (tool?.role !== 'tool') throw new Error('no tool');
    expect(tool.result.content).toContain('[truncated');
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm test tests/unit/orchestrator/QueryEngine.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `QueryEngine.ts`**

```ts
// src/orchestrator/QueryEngine.ts
import type { ChatRequest, ToolDefinition } from '../adapters/DeepSeekClient.js';
import type { AssistantMessage, Message, ToolResult } from '../adapters/messages.js';
import { hasToolCalls } from '../adapters/messages.js';
import { BudgetChecker, type BudgetThresholds } from './compaction/budgetChecker.js';
import { pruneToolOutputs } from './compaction/toolOutputPruner.js';
import { snipDeadEnds } from './compaction/snipper.js';
import { microCompact } from './compaction/microCompactor.js';

export type QueryEngineOptions = {
  systemPrompt: string;
  workingBudget: number;
  thresholds?: Partial<Omit<BudgetThresholds, 'workingBudget'>>;
  protectedTailMessages?: number;
  protectedTailTokens?: number;
  maxToolOutputChars?: number;
};

const DEFAULT_THRESHOLDS = {
  pruneThresholdPct: 80,
  snipThresholdPct: 85,
  microThresholdPct: 90,
  refusalThresholdPct: 95,
};

export type CompactionRefusal = Error & { kind: 'compaction_refused' };

export class QueryEngine {
  private readonly history: Message[] = [];
  private readonly checker: BudgetChecker;
  private readonly system: Message;
  private readonly opts: Required<Omit<QueryEngineOptions, 'thresholds'>> & { thresholds: BudgetThresholds };

  constructor(opts: QueryEngineOptions) {
    const thresholds: BudgetThresholds = {
      workingBudget: opts.workingBudget,
      ...DEFAULT_THRESHOLDS,
      ...opts.thresholds,
    };
    this.opts = {
      systemPrompt: opts.systemPrompt,
      workingBudget: opts.workingBudget,
      protectedTailMessages: opts.protectedTailMessages ?? 6,
      protectedTailTokens: opts.protectedTailTokens ?? 40_000,
      maxToolOutputChars: opts.maxToolOutputChars ?? 80_000,
      thresholds,
    };
    this.system = { role: 'system', content: opts.systemPrompt };
    this.checker = new BudgetChecker(thresholds);
  }

  appendUser(content: string): void {
    this.history.push({ role: 'user', content });
  }

  appendAssistant(msg: Omit<AssistantMessage, 'role'>): void {
    this.history.push({ role: 'assistant', ...msg });
  }

  appendToolResult(result: ToolResult): void {
    this.history.push({ role: 'tool', result });
  }

  /** R2: drop reasoning_content from assistant messages without tool_calls. */
  private applyR2(history: readonly Message[]): Message[] {
    return history.map((m) => {
      if (m.role === 'assistant' && !hasToolCalls(m) && m.reasoning_content) {
        const { reasoning_content: _r, ...rest } = m;
        return rest;
      }
      return m;
    });
  }

  prepareRequest(args: { model: string; tools: readonly ToolDefinition[]; thinking: boolean; strict: boolean; signal?: AbortSignal; options?: Readonly<Record<string, unknown>> }): ChatRequest {
    let working: Message[] = [...this.history];
    const verdict = this.checker.check(working);
    if (verdict.action === 'prune' || verdict.action === 'snip' || verdict.action === 'micro') {
      working = pruneToolOutputs(working, {
        maxToolOutputChars: this.opts.maxToolOutputChars,
        protectedTailMessages: this.opts.protectedTailMessages,
      });
    }
    if (verdict.action === 'snip' || verdict.action === 'micro') {
      working = snipDeadEnds(working, { protectedTailTokens: this.opts.protectedTailTokens });
    }
    if (verdict.action === 'micro') {
      working = microCompact(working, { protectedTailMessages: this.opts.protectedTailMessages });
    }
    if (verdict.action === 'refuse') {
      const err = new Error('compaction_required: working budget exhausted (layers 1-3 insufficient; layers 4-5 deferred to v2)') as CompactionRefusal;
      err.kind = 'compaction_refused';
      throw err;
    }
    const messages: Message[] = [this.system, ...this.applyR2(working)];
    return {
      model: args.model,
      messages,
      tools: args.tools,
      thinking: args.thinking,
      strict: args.strict,
      ...(args.signal ? { signal: args.signal } : {}),
      ...(args.options ? { options: args.options } : {}),
    };
  }

  snapshot(): readonly Message[] {
    return [...this.history];
  }
}
```

- [ ] **Step 4: Run to verify pass**

```bash
pnpm test tests/unit/orchestrator/QueryEngine.test.ts
```

Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/QueryEngine.ts tests/unit/orchestrator/QueryEngine.test.ts
git commit -m "feat(orchestrator): QueryEngine with R2 retention and compaction L1-3"
```

---

### Task 31: `reactLoop.ts` — async generator implementing ReAct

**Files:**

- Create: `src/orchestrator/reactLoop.ts`
- Test: `tests/integration/reactLoop.test.ts`

The loop: call `client.stream(req)` → consume StreamEvents → on `tool_call`, dispatch via `executeTool` → append result → loop. On final `done` with no tool_calls, exit.

- [ ] **Step 1: Write the failing test**

```ts
// tests/integration/reactLoop.test.ts
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { runReactLoop } from '../../src/orchestrator/reactLoop.js';
import { QueryEngine } from '../../src/orchestrator/QueryEngine.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import type { DeepSeekClient } from '../../src/adapters/DeepSeekClient.js';
import type { StreamEvent } from '../../src/adapters/streamEvent.js';

class ScriptedClient implements DeepSeekClient {
  readonly id = 'v3' as const;
  private callCount = 0;
  constructor(private readonly turns: StreamEvent[][]) {}
  async *stream(): AsyncIterable<StreamEvent> {
    const events = this.turns[this.callCount] ?? [];
    this.callCount++;
    for (const e of events) yield e;
  }
}

describe('runReactLoop (mock client)', () => {
  it('handles a single tool-call → tool-result → final-answer flow', async () => {
    const client = new ScriptedClient([
      [
        { type: 'reasoning_delta', text: 'I will echo' },
        { type: 'tool_call', id: 't1', name: 'echo', args: { msg: 'hi' } },
        { type: 'done', usage: { promptTokens: 5, completionTokens: 5, reasoningTokens: 3 } },
      ],
      [
        { type: 'content_delta', text: 'Done.' },
        { type: 'done', usage: { promptTokens: 10, completionTokens: 1, reasoningTokens: 0 } },
      ],
    ]);
    const engine = new QueryEngine({ systemPrompt: 'sys', workingBudget: 10_000 });
    const tools = new ToolRegistry();
    tools.register({ name: 'echo', description: 'd', capability: 'execution', inputSchema: z.object({ msg: z.string() }), run: async ({ msg }) => msg });
    engine.appendUser('say hi');
    const events: StreamEvent[] = [];
    for await (const ev of runReactLoop({ client, engine, tools, model: 'm' })) events.push(ev);
    expect(events.some((e) => e.type === 'reasoning_delta')).toBe(true);
    expect(events.some((e) => e.type === 'content_delta' && e.text === 'Done.')).toBe(true);
    const snap = engine.snapshot();
    expect(snap.find((m) => m.role === 'tool')).toMatchObject({ result: { content: 'hi', tool_use_id: 't1' } });
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm test tests/integration/reactLoop.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `reactLoop.ts`**

```ts
// src/orchestrator/reactLoop.ts
import type { DeepSeekClient } from '../adapters/DeepSeekClient.js';
import type { StreamEvent } from '../adapters/streamEvent.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolCall } from '../adapters/messages.js';
import type { QueryEngine } from './QueryEngine.js';

export type ReactLoopOptions = {
  client: DeepSeekClient;
  engine: QueryEngine;
  tools: ToolRegistry;
  model: string;
  maxIterations?: number;
  signal?: AbortSignal;
};

export async function* runReactLoop(opts: ReactLoopOptions): AsyncIterable<StreamEvent> {
  const maxIters = opts.maxIterations ?? 25;
  for (let iter = 0; iter < maxIters; iter++) {
    const request = opts.engine.prepareRequest({
      model: opts.model,
      tools: opts.tools.definitions(),
      thinking: true,
      strict: true,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });

    let assistantContent = '';
    let assistantReasoning = '';
    const pendingCalls: ToolCall[] = [];

    for await (const ev of opts.client.stream(request)) {
      yield ev;
      switch (ev.type) {
        case 'reasoning_delta':
          assistantReasoning += ev.text;
          break;
        case 'content_delta':
          assistantContent += ev.text;
          break;
        case 'tool_call':
          pendingCalls.push({ id: ev.id, name: ev.name, args: ev.args });
          break;
        case 'done':
        case 'error':
          break;
      }
    }

    opts.engine.appendAssistant({
      content: assistantContent,
      ...(assistantReasoning && pendingCalls.length > 0 ? { reasoning_content: assistantReasoning } : {}),
      ...(pendingCalls.length > 0 ? { tool_calls: pendingCalls } : {}),
    });

    if (pendingCalls.length === 0) return; // Terminal turn.

    for (const call of pendingCalls) {
      try {
        const content = await opts.tools.invoke(call.name, call.args);
        opts.engine.appendToolResult({
          tool_use_id: call.id,
          command: `${call.name} ${JSON.stringify(call.args)}`,
          is_error: false,
          content,
        });
      } catch (err) {
        opts.engine.appendToolResult({
          tool_use_id: call.id,
          command: `${call.name} ${JSON.stringify(call.args)}`,
          is_error: true,
          content: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  yield {
    type: 'error',
    cause: new Error(`ReAct loop exceeded maxIterations=${maxIters}`),
  };
}
```

- [ ] **Step 4: Run to verify pass**

```bash
pnpm test tests/integration/reactLoop.test.ts
```

Expected: PASS — 1 test.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/reactLoop.ts tests/integration/reactLoop.test.ts
git commit -m "feat(orchestrator): ReAct loop async generator with R2-aware history append"
```

---

## Phase 10 — Terminal UI (Ink + Clack)

### Task 32: Logger that never writes to stdout while Ink is mounted (U4)

**Files:**

- Create: `src/util/logger.ts`
- Test: `tests/unit/util/logger.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/util/logger.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../../../src/util/logger.js';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'myc-log-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('createLogger', () => {
  it('writes structured JSON lines to a file under .myceliate/logs/', async () => {
    const log = createLogger({ logsDir: join(dir, 'logs') });
    log.info({ event: 'hello', x: 1 });
    log.warn({ event: 'careful' });
    await log.flush();
    const file = await readFile(join(dir, 'logs', 'session.log'), 'utf8');
    const lines = file.trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ level: 'info', event: 'hello', x: 1 });
    expect(lines[1]).toMatchObject({ level: 'warn', event: 'careful' });
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm test tests/unit/util/logger.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `logger.ts`**

```ts
// src/util/logger.ts
import { mkdir, appendFile } from 'node:fs/promises';
import { join } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type Logger = {
  debug: (entry: Record<string, unknown>) => void;
  info: (entry: Record<string, unknown>) => void;
  warn: (entry: Record<string, unknown>) => void;
  error: (entry: Record<string, unknown>) => void;
  flush: () => Promise<void>;
};

export function createLogger(opts: { logsDir: string; file?: string }): Logger {
  const file = opts.file ?? 'session.log';
  const queue: string[] = [];
  let pending: Promise<void> = Promise.resolve();

  const enqueue = (level: LogLevel, entry: Record<string, unknown>): void => {
    const line = JSON.stringify({ ts: new Date().toISOString(), level, ...entry });
    queue.push(`${line}\n`);
    pending = pending.then(async () => {
      const batch = queue.splice(0).join('');
      if (!batch) return;
      await mkdir(opts.logsDir, { recursive: true });
      await appendFile(join(opts.logsDir, file), batch, 'utf8');
    });
  };

  return {
    debug: (e) => enqueue('debug', e),
    info: (e) => enqueue('info', e),
    warn: (e) => enqueue('warn', e),
    error: (e) => enqueue('error', e),
    flush: async () => { await pending; },
  };
}
```

- [ ] **Step 4: Run to verify pass**

```bash
pnpm test tests/unit/util/logger.test.ts
```

Expected: PASS — 1 test.

- [ ] **Step 5: Commit**

```bash
git add src/util/logger.ts tests/unit/util/logger.test.ts
git commit -m "feat(util): file-only structured logger (U4)"
```

---

### Task 33: Incremental Markdown parser (O(n))

**Files:**

- Create: `src/ui/markdown/incrementalParser.ts`
- Test: `tests/unit/ui/incrementalParser.test.ts`

The parser maintains state between feeds. It identifies completed blocks (paragraphs, fenced code blocks, headings) and locks them; only the trailing open block is reparsed per feed.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/ui/incrementalParser.test.ts
import { describe, it, expect } from 'vitest';
import { IncrementalMarkdownParser, type Block } from '../../../src/ui/markdown/incrementalParser.js';

describe('IncrementalMarkdownParser', () => {
  it('locks a paragraph when a blank line follows', () => {
    const p = new IncrementalMarkdownParser();
    p.feed('hello world');
    expect(p.completedBlocks()).toHaveLength(0);
    p.feed('\n\nnext line');
    const completed = p.completedBlocks();
    expect(completed).toHaveLength(1);
    expect(completed[0]).toEqual<Block>({ type: 'paragraph', text: 'hello world' });
  });

  it('detects fenced code blocks with language tag', () => {
    const p = new IncrementalMarkdownParser();
    p.feed('```ts\nconst x = 1;\n```\n\nafter');
    const completed = p.completedBlocks();
    expect(completed[0]).toEqual<Block>({ type: 'code', language: 'ts', text: 'const x = 1;' });
  });

  it('detects ATX headings', () => {
    const p = new IncrementalMarkdownParser();
    p.feed('# Title\n\nbody\n\n');
    const completed = p.completedBlocks();
    expect(completed[0]).toEqual<Block>({ type: 'heading', level: 1, text: 'Title' });
    expect(completed[1]).toEqual<Block>({ type: 'paragraph', text: 'body' });
  });

  it('returns the open trailing block separately', () => {
    const p = new IncrementalMarkdownParser();
    p.feed('first paragraph\n\nsecond para');
    expect(p.completedBlocks()).toHaveLength(1);
    expect(p.openBlock()).toEqual<Block>({ type: 'paragraph', text: 'second para' });
  });

  it('is O(n): processing a 100k-char feed runs in linear time', () => {
    const p = new IncrementalMarkdownParser();
    const big = ('para\n\n').repeat(20_000); // 120k chars, 20k completed blocks
    const t0 = performance.now();
    p.feed(big);
    const elapsed = performance.now() - t0;
    expect(p.completedBlocks().length).toBe(20_000);
    expect(elapsed).toBeLessThan(500); // generous; linear should be << 500ms
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm test tests/unit/ui/incrementalParser.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `incrementalParser.ts`**

```ts
// src/ui/markdown/incrementalParser.ts
export type Block =
  | { type: 'paragraph'; text: string }
  | { type: 'code'; language: string; text: string }
  | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; text: string };

type ParserMode = 'normal' | 'code';

export class IncrementalMarkdownParser {
  private buffer = '';
  private mode: ParserMode = 'normal';
  private codeLang = '';
  private codeBuf = '';
  private completed: Block[] = [];

  feed(chunk: string): void {
    this.buffer += chunk;
    let progress = true;
    while (progress) {
      progress = false;
      if (this.mode === 'normal') {
        // Try to lock a heading line: requires a newline.
        if (this.buffer.startsWith('#')) {
          const nl = this.buffer.indexOf('\n');
          if (nl !== -1) {
            const line = this.buffer.slice(0, nl);
            const m = line.match(/^(#{1,6})\s+(.*)$/);
            if (m) {
              this.completed.push({ type: 'heading', level: m[1]!.length as 1 | 2 | 3 | 4 | 5 | 6, text: m[2]! });
              this.buffer = this.buffer.slice(nl + 1).replace(/^\n+/, '');
              progress = true;
              continue;
            }
          }
        }
        // Try to enter code mode on opening fence at start of buffer.
        if (this.buffer.startsWith('```')) {
          const nl = this.buffer.indexOf('\n');
          if (nl !== -1) {
            this.codeLang = this.buffer.slice(3, nl).trim();
            this.buffer = this.buffer.slice(nl + 1);
            this.mode = 'code';
            this.codeBuf = '';
            progress = true;
            continue;
          }
        }
        // Lock a paragraph at the next blank line.
        const blank = this.buffer.indexOf('\n\n');
        if (blank !== -1) {
          const text = this.buffer.slice(0, blank).trim();
          if (text.length > 0) this.completed.push({ type: 'paragraph', text });
          this.buffer = this.buffer.slice(blank + 2);
          progress = true;
        }
      } else {
        // In code mode: look for closing fence.
        const fence = this.buffer.indexOf('```');
        if (fence !== -1) {
          this.codeBuf += this.buffer.slice(0, fence).replace(/\n$/, '');
          this.completed.push({ type: 'code', language: this.codeLang, text: this.codeBuf });
          this.buffer = this.buffer.slice(fence + 3).replace(/^\n+/, '');
          this.mode = 'normal';
          this.codeBuf = '';
          this.codeLang = '';
          progress = true;
        } else {
          // Move what we have into the code buffer; wait for more input.
          this.codeBuf += this.buffer;
          this.buffer = '';
        }
      }
    }
  }

  completedBlocks(): readonly Block[] {
    return this.completed;
  }

  openBlock(): Block | null {
    if (this.mode === 'code') {
      return { type: 'code', language: this.codeLang, text: this.codeBuf };
    }
    if (this.buffer.trim().length === 0) return null;
    return { type: 'paragraph', text: this.buffer.trim() };
  }
}
```

- [ ] **Step 4: Run to verify pass**

```bash
pnpm test tests/unit/ui/incrementalParser.test.ts
```

Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/ui/markdown/incrementalParser.ts tests/unit/ui/incrementalParser.test.ts
git commit -m "feat(ui): O(n) incremental Markdown parser locking completed blocks"
```

---

### Task 34: `MarkdownRenderer` Ink component

**Files:**

- Create: `src/ui/markdown/MarkdownRenderer.tsx`
- Test: `tests/unit/ui/MarkdownRenderer.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// tests/unit/ui/MarkdownRenderer.test.tsx
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { MarkdownRenderer } from '../../../src/ui/markdown/MarkdownRenderer.js';
import type { Block } from '../../../src/ui/markdown/incrementalParser.js';

describe('MarkdownRenderer', () => {
  it('renders headings with leading hashes', () => {
    const blocks: Block[] = [{ type: 'heading', level: 2, text: 'Hi' }];
    const { lastFrame } = render(<MarkdownRenderer blocks={blocks} open={null} />);
    expect(lastFrame()).toContain('## Hi');
  });

  it('renders fenced code with language label', () => {
    const blocks: Block[] = [{ type: 'code', language: 'ts', text: 'const x = 1;' }];
    const { lastFrame } = render(<MarkdownRenderer blocks={blocks} open={null} />);
    expect(lastFrame()).toContain('ts');
    expect(lastFrame()).toContain('const x = 1;');
  });

  it('renders paragraphs and the open block', () => {
    const blocks: Block[] = [{ type: 'paragraph', text: 'first' }];
    const { lastFrame } = render(<MarkdownRenderer blocks={blocks} open={{ type: 'paragraph', text: 'open…' }} />);
    expect(lastFrame()).toContain('first');
    expect(lastFrame()).toContain('open…');
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm test tests/unit/ui/MarkdownRenderer.test.tsx
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `MarkdownRenderer.tsx`**

```tsx
// src/ui/markdown/MarkdownRenderer.tsx
import { Box, Text } from 'ink';
import React from 'react';
import type { Block } from './incrementalParser.js';

export function MarkdownRenderer({ blocks, open }: { blocks: readonly Block[]; open: Block | null }): React.JSX.Element {
  return (
    <Box flexDirection="column">
      {blocks.map((b, i) => (
        <BlockView key={i} block={b} />
      ))}
      {open !== null && <BlockView block={open} dimmed />}
    </Box>
  );
}

function BlockView({ block, dimmed }: { block: Block; dimmed?: boolean }): React.JSX.Element {
  switch (block.type) {
    case 'heading':
      return (
        <Text bold dimColor={dimmed}>
          {'#'.repeat(block.level)} {block.text}
        </Text>
      );
    case 'paragraph':
      return <Text dimColor={dimmed}>{block.text}</Text>;
    case 'code':
      return (
        <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
          <Text color="cyan" dimColor={dimmed}>
            {block.language}
          </Text>
          <Text dimColor={dimmed}>{block.text}</Text>
        </Box>
      );
  }
}
```

- [ ] **Step 4: Run to verify pass**

```bash
pnpm test tests/unit/ui/MarkdownRenderer.test.tsx
```

Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/ui/markdown/MarkdownRenderer.tsx tests/unit/ui/MarkdownRenderer.test.tsx
git commit -m "feat(ui): Ink MarkdownRenderer over incremental block stream"
```

---

### Task 35: `ReasoningBlock` — stateful collapsible

**Files:**

- Create: `src/ui/ReasoningBlock.tsx`
- Test: `tests/unit/ui/ReasoningBlock.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// tests/unit/ui/ReasoningBlock.test.tsx
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { ReasoningBlock } from '../../../src/ui/ReasoningBlock.js';

describe('ReasoningBlock', () => {
  it('renders streaming text expanded while phase=streaming', () => {
    const { lastFrame } = render(<ReasoningBlock text="thinking deeply" phase="streaming" durationMs={1200} />);
    expect(lastFrame()).toContain('thinking deeply');
  });

  it('collapses to a single summary line when phase=complete', () => {
    const { lastFrame } = render(<ReasoningBlock text="long internal monologue spanning many words" phase="complete" durationMs={3400} />);
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('long internal monologue');
    expect(frame).toMatch(/Reasoning.*3\.4s/);
  });

  it('shows expanded view when expanded prop is true even after complete', () => {
    const { lastFrame } = render(<ReasoningBlock text="full text here" phase="complete" durationMs={500} expanded />);
    expect(lastFrame()).toContain('full text here');
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm test tests/unit/ui/ReasoningBlock.test.tsx
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `ReasoningBlock.tsx`**

```tsx
// src/ui/ReasoningBlock.tsx
import { Box, Text } from 'ink';
import React from 'react';

export type ReasoningPhase = 'streaming' | 'complete';

export type ReasoningBlockProps = {
  text: string;
  phase: ReasoningPhase;
  durationMs: number;
  expanded?: boolean;
};

export function ReasoningBlock({ text, phase, durationMs, expanded = false }: ReasoningBlockProps): React.JSX.Element {
  const showFull = phase === 'streaming' || expanded;
  if (!showFull) {
    return (
      <Text dimColor>
        {'> '} Reasoning ({(durationMs / 1000).toFixed(1)}s) — press Tab to expand
      </Text>
    );
  }
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
      <Text dimColor italic>
        ── reasoning {phase === 'streaming' ? '(streaming…)' : `(${(durationMs / 1000).toFixed(1)}s)`} ──
      </Text>
      <Text dimColor>{text}</Text>
    </Box>
  );
}
```

- [ ] **Step 4: Run to verify pass**

```bash
pnpm test tests/unit/ui/ReasoningBlock.test.tsx
```

Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/ui/ReasoningBlock.tsx tests/unit/ui/ReasoningBlock.test.tsx
git commit -m "feat(ui): stateful collapsible ReasoningBlock"
```

---

### Task 36: `ContentStream` — wires incremental parser to MarkdownRenderer

**Files:**

- Create: `src/ui/ContentStream.tsx`
- Test: `tests/unit/ui/ContentStream.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// tests/unit/ui/ContentStream.test.tsx
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { ContentStream } from '../../../src/ui/ContentStream.js';

describe('ContentStream', () => {
  it('renders incoming chunks as they arrive', () => {
    const { lastFrame, rerender } = render(<ContentStream text="hello" />);
    expect(lastFrame()).toContain('hello');
    rerender(<ContentStream text="hello\n\n# H1\n\n" />);
    expect(lastFrame()).toContain('# H1');
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm test tests/unit/ui/ContentStream.test.tsx
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `ContentStream.tsx`**

```tsx
// src/ui/ContentStream.tsx
import React, { useMemo } from 'react';
import { IncrementalMarkdownParser } from './markdown/incrementalParser.js';
import { MarkdownRenderer } from './markdown/MarkdownRenderer.js';

export function ContentStream({ text }: { text: string }): React.JSX.Element {
  // Re-parse from scratch on each render. The parser itself is O(n); we accept
  // the per-render allocation for simplicity. For a long-running session, lift
  // the parser into a ref and feed only the delta.
  const { blocks, open } = useMemo(() => {
    const p = new IncrementalMarkdownParser();
    p.feed(text);
    return { blocks: p.completedBlocks(), open: p.openBlock() };
  }, [text]);
  return <MarkdownRenderer blocks={blocks} open={open} />;
}
```

- [ ] **Step 4: Run to verify pass**

```bash
pnpm test tests/unit/ui/ContentStream.test.tsx
```

Expected: PASS — 1 test.

- [ ] **Step 5: Commit**

```bash
git add src/ui/ContentStream.tsx tests/unit/ui/ContentStream.test.tsx
git commit -m "feat(ui): ContentStream composing parser + renderer"
```

---

### Task 37: `ApprovalPrompt` — HITL UI

**Files:**

- Create: `src/ui/ApprovalPrompt.tsx`
- Test: `tests/unit/ui/ApprovalPrompt.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// tests/unit/ui/ApprovalPrompt.test.tsx
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { ApprovalPrompt } from '../../../src/ui/ApprovalPrompt.js';

describe('ApprovalPrompt', () => {
  it('renders the command, cwd, and reason', () => {
    const { lastFrame } = render(
      <ApprovalPrompt
        request={{ command: 'rm -rf /tmp/foo', cwd: '/work', reason: 'recursive delete' }}
        onResponse={() => {}}
      />,
    );
    const f = lastFrame() ?? '';
    expect(f).toContain('rm -rf /tmp/foo');
    expect(f).toContain('/work');
    expect(f).toContain('recursive delete');
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm test tests/unit/ui/ApprovalPrompt.test.tsx
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `ApprovalPrompt.tsx`**

```tsx
// src/ui/ApprovalPrompt.tsx
import { Box, Text, useInput } from 'ink';
import React from 'react';
import type { ApprovalRequest, ApprovalResponse } from '../security/hitlGate.js';

export function ApprovalPrompt({ request, onResponse }: { request: ApprovalRequest; onResponse: (r: ApprovalResponse) => void }): React.JSX.Element {
  useInput((input) => {
    if (input === 'y' || input === 'Y') onResponse({ decision: 'approve' });
    else if (input === 'n' || input === 'N') onResponse({ decision: 'reject' });
  });
  return (
    <Box flexDirection="column" borderStyle="double" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">⚠ Approval required</Text>
      <Text>Command: <Text bold>{request.command}</Text></Text>
      <Text>Cwd: {request.cwd}</Text>
      <Text>Reason: {request.reason}</Text>
      <Text dimColor>Press Y to approve, N to reject.</Text>
    </Box>
  );
}
```

- [ ] **Step 4: Run to verify pass**

```bash
pnpm test tests/unit/ui/ApprovalPrompt.test.tsx
```

Expected: PASS — 1 test.

- [ ] **Step 5: Commit**

```bash
git add src/ui/ApprovalPrompt.tsx tests/unit/ui/ApprovalPrompt.test.tsx
git commit -m "feat(ui): ApprovalPrompt with Y/N keyboard handling"
```

---

### Task 38: `App.tsx` — top-level Ink layout (dual stream)

**Files:**

- Create: `src/ui/App.tsx`
- Test: `tests/unit/ui/App.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// tests/unit/ui/App.test.tsx
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { App, type AppState } from '../../../src/ui/App.js';

describe('App', () => {
  it('renders the reasoning block above the content stream', () => {
    const state: AppState = {
      userInput: 'do thing',
      reasoning: { text: 'thinking', phase: 'streaming', startedAtMs: Date.now() },
      content: 'partial answer',
      approvalRequest: null,
    };
    const { lastFrame } = render(<App state={state} />);
    const f = lastFrame() ?? '';
    expect(f).toContain('thinking');
    expect(f).toContain('partial answer');
  });

  it('shows the approval prompt overlay when approvalRequest is present', () => {
    const state: AppState = {
      userInput: 'do thing',
      reasoning: null,
      content: '',
      approvalRequest: { command: 'rm -rf x', cwd: '/x', reason: 'why' },
    };
    const { lastFrame } = render(<App state={state} />);
    expect(lastFrame()).toContain('Approval required');
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm test tests/unit/ui/App.test.tsx
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `App.tsx`**

```tsx
// src/ui/App.tsx
import { Box, Text } from 'ink';
import React from 'react';
import { ReasoningBlock } from './ReasoningBlock.js';
import { ContentStream } from './ContentStream.js';
import { ApprovalPrompt } from './ApprovalPrompt.js';
import type { ApprovalRequest, ApprovalResponse } from '../security/hitlGate.js';

export type ReasoningState = { text: string; phase: 'streaming' | 'complete'; startedAtMs: number };

export type AppState = {
  userInput: string;
  reasoning: ReasoningState | null;
  content: string;
  approvalRequest: ApprovalRequest | null;
};

export function App({ state, onApprovalResponse }: { state: AppState; onApprovalResponse?: (r: ApprovalResponse) => void }): React.JSX.Element {
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text color="green">{'> '}</Text>
        <Text>{state.userInput}</Text>
      </Box>
      {state.reasoning !== null && (
        <ReasoningBlock
          text={state.reasoning.text}
          phase={state.reasoning.phase}
          durationMs={Date.now() - state.reasoning.startedAtMs}
        />
      )}
      {state.content.length > 0 && <ContentStream text={state.content} />}
      {state.approvalRequest !== null && (
        <ApprovalPrompt request={state.approvalRequest} onResponse={onApprovalResponse ?? (() => {})} />
      )}
    </Box>
  );
}
```

- [ ] **Step 4: Run to verify pass**

```bash
pnpm test tests/unit/ui/App.test.tsx
```

Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/ui/App.tsx tests/unit/ui/App.test.tsx
git commit -m "feat(ui): App composing dual stream with HITL overlay"
```

---

### Task 39: Clack onboarding (pre-Ink)

**Files:**

- Create: `src/ui/onboarding.ts`

No unit test — Clack's prompts read from stdin, requiring an interactive TTY. Smoke-tested manually in Task 41.

- [ ] **Step 1: Implement `onboarding.ts`**

```ts
// src/ui/onboarding.ts
import { intro, outro, select, text, isCancel, cancel } from '@clack/prompts';

export type OnboardingResult = {
  apiKey: string;
  adapter: 'v3' | 'v4';
  model: string;
  initialPrompt: string;
};

export async function runOnboarding(defaults: { apiKey?: string; adapter?: 'v3' | 'v4'; model?: string }): Promise<OnboardingResult> {
  intro('myceliate-cli — autonomous DeepSeek agent');

  const apiKey = defaults.apiKey ?? (await text({
    message: 'DeepSeek API key',
    placeholder: 'sk-...',
    validate: (v) => (v.length < 20 ? 'API key looks too short' : undefined),
  })) as string;
  if (isCancel(apiKey)) { cancel('Aborted.'); process.exit(0); }

  const adapter = defaults.adapter ?? (await select({
    message: 'Adapter',
    options: [
      { value: 'v3', label: 'v3 — DeepSeek Reasoner (works today)' },
      { value: 'v4', label: 'v4 — DeepSeek V4 (DSML, when available)' },
    ],
  })) as 'v3' | 'v4';
  if (isCancel(adapter)) { cancel('Aborted.'); process.exit(0); }

  const model = defaults.model ?? (adapter === 'v3' ? 'deepseek-reasoner' : 'deepseek-v4-pro');

  const initialPrompt = await text({ message: 'What would you like the agent to do?' }) as string;
  if (isCancel(initialPrompt)) { cancel('Aborted.'); process.exit(0); }

  outro('Starting agent…');
  return { apiKey, adapter, model, initialPrompt };
}
```

- [ ] **Step 2: Verify type-check**

```bash
pnpm typecheck
```

Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add src/ui/onboarding.ts
git commit -m "feat(ui): Clack onboarding flow (apiKey, adapter, model, prompt)"
```

---

## Phase 11 — Wiring & Manual Smoke

### Task 40: `index.ts` — entry point wiring everything together

**Files:**

- Create: `src/index.ts`

This wires Clack onboarding → adapter selection → ToolRegistry seeding → QueryEngine bootstrap → Ink mount → ReAct loop driving Ink state.

- [ ] **Step 1: Implement `index.ts`**

```ts
// src/index.ts
import { render } from 'ink';
import React from 'react';
import { runOnboarding } from './ui/onboarding.js';
import { App, type AppState } from './ui/App.js';
import { V3Adapter } from './adapters/v3/adapter.js';
import { V4Adapter } from './adapters/v4/adapter.js';
import type { DeepSeekClient } from './adapters/DeepSeekClient.js';
import { senseContext } from './orchestrator/context.js';
import { QueryEngine } from './orchestrator/QueryEngine.js';
import { runReactLoop } from './orchestrator/reactLoop.js';
import { ToolRegistry } from './tools/registry.js';
import { readFileTool } from './tools/readFile.js';
import { writeFileTool } from './tools/writeFile.js';
import { listDirTool } from './tools/listDir.js';
import { grepTool } from './tools/grep.js';
import { MarkdownStore } from './memory/markdownStore.js';
import { ConversationLog } from './memory/conversationLog.js';
import { createLogger } from './util/logger.js';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

async function main(): Promise<void> {
  const onboarding = await runOnboarding({
    ...(process.env.DEEPSEEK_API_KEY ? { apiKey: process.env.DEEPSEEK_API_KEY } : {}),
    ...(process.env.DEEPSEEK_ADAPTER === 'v3' || process.env.DEEPSEEK_ADAPTER === 'v4' ? { adapter: process.env.DEEPSEEK_ADAPTER } : {}),
    ...(process.env.DEEPSEEK_MODEL ? { model: process.env.DEEPSEEK_MODEL } : {}),
  });

  const ctx = await senseContext({ cwd: process.cwd() });
  const sessionId = randomUUID();
  const logger = createLogger({ logsDir: join(ctx.memoryDir, 'logs') });
  const memory = new MarkdownStore(ctx.memoryDir);
  const conversation = new ConversationLog(memory, sessionId);

  const baseUrl = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com';
  const client: DeepSeekClient = onboarding.adapter === 'v3'
    ? new V3Adapter({ apiKey: onboarding.apiKey, baseUrl })
    : new V4Adapter({ apiKey: onboarding.apiKey, baseUrl });

  const tools = new ToolRegistry();
  tools.register(readFileTool);
  tools.register(writeFileTool);
  tools.register(listDirTool);
  tools.register(grepTool);

  const engine = new QueryEngine({
    systemPrompt: ctx.claudeMd || 'You are myceliate, an autonomous CLI agent.',
    workingBudget: Number(process.env.WORKING_TOKEN_BUDGET ?? 200_000),
  });
  engine.appendUser(onboarding.initialPrompt);
  await conversation.appendTurn({ role: 'user', content: onboarding.initialPrompt });

  let state: AppState = { userInput: onboarding.initialPrompt, reasoning: null, content: '', approvalRequest: null };
  const ink = render(React.createElement(App, { state }));

  const reasonStartedAt = Date.now();
  let reasoningText = '';
  let contentText = '';

  for await (const ev of runReactLoop({ client, engine, tools, model: onboarding.model })) {
    if (ev.type === 'reasoning_delta') {
      reasoningText += ev.text;
      state = { ...state, reasoning: { text: reasoningText, phase: 'streaming', startedAtMs: reasonStartedAt } };
    } else if (ev.type === 'content_delta') {
      if (state.reasoning && state.reasoning.phase === 'streaming') {
        state = { ...state, reasoning: { ...state.reasoning, phase: 'complete' } };
      }
      contentText += ev.text;
      state = { ...state, content: contentText };
    } else if (ev.type === 'tool_call') {
      logger.info({ event: 'tool_call', name: ev.name, id: ev.id });
    } else if (ev.type === 'error') {
      logger.error({ event: 'stream_error', message: ev.cause.message });
    }
    ink.rerender(React.createElement(App, { state }));
  }

  for (const m of engine.snapshot()) await conversation.appendTurn(m);
  await logger.flush();
  ink.unmount();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Type-check**

```bash
pnpm typecheck
```

Expected: zero errors.

- [ ] **Step 3: Build**

```bash
pnpm build
```

Expected: `dist/` populated with compiled JS + .d.ts.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat(cli): index.ts wiring onboarding, adapter, engine, ReAct, Ink"
```

---

### Task 41: Manual smoke verification (UI/feature correctness can't be unit-tested)

**Files:**

- Create: `docs/MANUAL_SMOKE.md`

Per `CLAUDE.md` and the parent system prompt, UI features need manual verification in a real terminal. This task produces a checklist the user runs through after Task 40 builds.

- [ ] **Step 1: Write the checklist**

```md
# Manual smoke verification — myceliate-cli vertical slice

Pre-flight:
- [ ] `pnpm install` completes
- [ ] `cp .env.example .env` and add `DEEPSEEK_API_KEY=sk-...`
- [ ] `pnpm redis:up` succeeds; `docker ps` shows `myceliate-redis`
- [ ] `pnpm test` — all unit + integration tests pass
- [ ] `pnpm typecheck` clean
- [ ] `pnpm build` succeeds

Worker smoke:
- [ ] `pnpm queue:worker` in terminal A logs the consuming line
- [ ] Sending a job from a REPL drains it; logs `event: completed` with `exitCode: 0`

CLI smoke (terminal B):
- [ ] `pnpm dev` shows the Clack onboarding (intro → API key → adapter → model → prompt)
- [ ] Adapter `v3` + prompt `"list the files in the cwd and tell me which is largest"` runs
- [ ] Reasoning block streams text while the model is thinking
- [ ] Reasoning block collapses to `> Reasoning (Ns)` when content begins
- [ ] Tab toggles reasoning expansion (if implemented; otherwise note as deferred)
- [ ] Final answer renders with Markdown formatting (heading + paragraph + maybe a list)
- [ ] No ANSI corruption / interleaving
- [ ] `.myceliate/history/<session>.md` is written and contains the turn log
- [ ] `.myceliate/logs/session.log` is written and parses as JSON lines

HITL smoke:
- [ ] Prompt `"delete /tmp/foo recursively"` triggers the approval prompt
- [ ] Pressing `n` rejects; the agent receives the rejection and recalibrates
- [ ] Pressing `y` approves; the command (in a safe sandbox path) executes

Compaction smoke:
- [ ] Set `WORKING_TOKEN_BUDGET=2000` and feed the agent a task that reads several files
- [ ] Logs show compaction actions (`prune` then `snip` then `micro`) as the budget tightens

Note any FAIL items as new tasks; do not mark this checklist complete until every item is checked.
```

- [ ] **Step 2: Commit**

```bash
git add docs/MANUAL_SMOKE.md
git commit -m "docs: manual smoke verification checklist"
```

---

## Acceptance Criteria

The vertical slice is complete when:

1. All unit tests pass: `pnpm test` green.
2. The integration tests (with Redis up) pass: `REDIS_URL=redis://localhost:6379 pnpm test:integration` green.
3. `pnpm typecheck` and `pnpm lint` are clean.
4. `pnpm build` produces a runnable `dist/index.js`.
5. The `MANUAL_SMOKE.md` checklist is fully ticked.
6. `CLAUDE.md` rules R1–R12 and U1–U4 are reflected in the code (verified by self-review).
7. No item from the "Deferred to v2" list in `CLAUDE.md` has been implemented.

---

## Out-of-scope reminders

If during execution you find yourself about to implement any of the following, stop and surface it as scope expansion:

- ACE virtual projections (compaction layer 4)
- Structured 9-section auto-compaction (compaction layer 5)
- Dynamic multi-provider routing (Groq / Cerebras / Gemini Flash adapters)
- Daemonised heartbeat / cron-style proactive checks
- Full ephemeral execution sandboxing (microVM, unshare, gVisor)
- Continuous-learning skill synthesis (Hermes-style)
- MCP server integration
- FTS5 / SQLite memory store











