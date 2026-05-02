# myceliate-cli — Architectural Constraints

This file is the persistent system prompt for any agent (human or AI) working in this repository. It defines the non-negotiable architectural rules. Treat it as the contract; treat any code that violates it as a bug.

This file is intentionally stable to maximise prompt-cache hit rates against the DeepSeek API. Do not append transient state, task lists, or session notes.

---

## Mission

Build an autonomous CLI agent against the **DeepSeek V4** API surface (Thinking Mode, `reasoning_content` retention, DSML tool-call markup, strict-mode JSON Schema), runnable today via a V3-reasoner adapter, with a clean upgrade path to V4 when the endpoint ships.

Core paradigm: **Thin Agent / Fat Platform**. The platform owns the knowledge graph, lifecycle, persistent state, and security boundaries. Sub-agents are stateless, ephemeral, and narrow.

---

## Stack — locked

- **Runtime:** Node.js ≥ 20.11 (LTS). No Bun, no Deno.
- **Language:** TypeScript, `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`.
- **Module system:** ESM (`"type": "module"`). `NodeNext` resolution. Imports use explicit `.js` extensions.
- **Package manager:** pnpm preferred; npm acceptable. Never check `node_modules` in.
- **Tooling:** Biome (format + lint), Vitest (test), tsx (dev runner), tsc (build).
- **TUI:** `ink` (declarative streaming) + `@clack/prompts` (interactive primitives). No raw `process.stdout.write` in user-facing paths.
- **Queue:** `bullmq` over Redis. Redis runs via the project's `docker-compose.yml`. No alternative queue libraries in v1.
- **Schema validation:** `zod`. JSON Schemas for tool inputs are derived from Zod schemas, not hand-written.

---

## Architectural Rules

### R1 — Adapters own their wire format end-to-end

The `DeepSeekClient` interface (`src/adapters/DeepSeekClient.ts`) is shaped to V4: it returns `AsyncIterable<StreamEvent>` where `StreamEvent` is a canonical sum type. Each adapter (`v3`, `v4`, future) parses its own wire format directly into `StreamEvent`. **There is no translation middleware between providers.** Do not add a "normalizer" layer that converts V3 JSON tool_calls into DSML strings or vice versa — that re-introduces the JSON-in-string parsing failures DSML was designed to eliminate.

What is shared:

- `src/adapters/streamEvent.ts` — the canonical event sum type.
- `src/transport/sseClient.ts` — the SSE byte-stream primitive both adapters compose.
- `src/tools/schema.ts` — Zod-derived JSON Schema validators (provider-agnostic).

Adding a new provider (Groq, Cerebras, Gemini Flash for v2 routing) means implementing the interface. Nothing else changes.

### R2 — Reasoning content is preserved across tool calls only

DeepSeek V4 retains `reasoning_content` cumulatively across multi-turn loops *only when* tool calls occur in the conversation. The orchestrator MUST:

- Retain `reasoning_content` from any assistant message that includes a `tool_calls` field, and pass it back in the next API request.
- Discard `reasoning_content` from purely conversational turns to keep the working context small.

Failure here causes API 400s on V4 and silently degrades reasoning quality on V3.

### R3 — Strict-mode API only

All tool definitions submitted to the API set `additionalProperties: false`, list every property in `required`, and refuse partial schemas. The Zod schema is the source of truth; the JSON Schema is generated, never hand-edited.

### R4 — Streaming-first

Never call non-streaming completion endpoints. Every adapter's primary entry point is `stream(request)`. Buffered/awaited responses are built by collecting the stream where needed (testing, logging) — never the other way around.

### R5 — Native shell over MCP for local tools

File reads, writes, directory listings, `grep`, and shell execution are native TypeScript tools registered in `src/tools/`. They are never wrapped in an MCP server. MCP is reserved for v2 external integrations (issue trackers, cloud DBs) that genuinely require auth and routing.

### R6 — Heavy I/O goes through BullMQ; the main loop never blocks

These operations MUST be dispatched as BullMQ jobs, never invoked inline on the main event loop:

- `bash` execution of any command expected to run > 500 ms (compilers, tests, `docker build`, `git clone`, network requests).
- Test-suite runs.
- Docker image builds.

The job worker (`src/queue/worker.ts`) uses `child_process.spawn` (never `exec`, which buffers stdout and crashes on large output). Job results are emitted back to the orchestrator via BullMQ's `completed` / `failed` events; the orchestrator's notification bridge re-injects them into the message history, naturally triggering the next ReAct iteration.

Lightweight, deterministic operations (`fs.readFile`, `fs.readdir`, in-process regex) execute synchronously in-process.

### R7 — Memory is Markdown files, version-controllable

Persistent agent state lives under `.myceliate/` in the user's working directory:

- `.myceliate/history/<session-id>.md` — append-only conversation log.
- `.myceliate/skills/*.md` — JIT-loaded skill files (deferred-content, loaded into context only when intent matches).
- `.myceliate/memory/anchors.md` — Zero-Lie anchor documents re-injected after compaction.
- `CLAUDE.md` (project root) — this file. Loaded on every session init.

No SQL, no NoSQL, no embeddings DB in v1. Plain Markdown. The agent's memory must be `git diff`-able alongside the user's source code.

### R8 — Sub-agents are stateless and ephemeral

Sub-agents (workers spawned by the orchestrator for narrow tasks) are short scripts: < 150 LOC, no persistent state, fresh context window per spawn. They do not import from the orchestrator's runtime; they communicate via JSON payloads on stdin/stdout.

### R9 — Mutual exclusion of capabilities

Tools are partitioned into two sets:

- **Coordination tools** (`spawn_subagent`, `delegate_task`) — available to the orchestrator only. The orchestrator has no `write_file` / `bash` permissions.
- **Execution tools** (`read_file`, `write_file`, `bash`, `grep`, `list_dir`) — available to sub-agents. Sub-agents have no spawn permissions.

This prevents recursive agent loops and forces a flat, predictable execution graph.

### R10 — Compaction runs in strict order

When the working token budget threshold is crossed, compaction layers run in this order. v1 implements layers 1–3 only:

1. **Budget pruning** (`compaction/budgetChecker.ts` + `toolOutputPruner.ts`) — truncate verbose tool outputs over 20k tokens; deduplicate redundant `read_file` results.
2. **History snipping** (`compaction/snipper.ts`) — remove "zombie" exploration branches where the agent abandoned a trajectory; protect the system prompt, anchor docs, and the most recent 40k tokens.
3. **Cache-aware micro-compaction** (`compaction/microCompactor.ts`) — clear the `text` payload of old tool results while preserving `tool_use_id`, command string, and `is_error` flag. Surgical metadata retention.

**v1 does NOT implement:**

- Layer 4 (ACE virtual projections) — deferred to v2.
- Layer 5 (structured 9-section auto-compaction) — deferred to v2.

When the working budget exceeds 95% and only layers 1–3 are available, the orchestrator MUST refuse new tool calls and emit a `compaction_required` event to the UI rather than silently truncating critical context.

### R11 — Security is enforced at the gateway, not by the LLM

Two gates protect the host:

1. **Static blocklist** (`security/dangerousPatterns.ts`) — regex-matched against any proposed shell command. Patterns include `rm -rf /`, recursive deletes outside cwd, `curl | sh` pipes, network commands (`curl`, `wget`, `nc`), sudo, kernel/init mutations. Match → suspend execution and route to HITL.
2. **HITL approval** (`security/hitlGate.ts` + `ui/ApprovalPrompt.tsx`) — any blocked command, any write outside cwd, any file delete shows an approval prompt with the exact command, the proposed action, and the affected paths. User responses: approve / approve-once / reject / reject-with-feedback.

**Egress redaction** (`security/redactor.ts`) — every payload sent to an LLM endpoint is scanned for secrets (API keys matching common provider patterns, JWTs, PEM blocks, `.env`-style assignments, DB connection strings). Matches are replaced with `[REDACTED:<kind>]` before transmission. Failure to redact is a critical bug.

### R12 — Token budget is artificially capped

Despite V4's 1M-token context window, the orchestrator's working token budget is capped at `WORKING_TOKEN_BUDGET` (default 200k). This optimises cache hit rates and per-turn latency. The cap is enforced in `compaction/budgetChecker.ts`.

---

## UI Rules

### U1 — Dual-stream layout

The Ink tree always renders two regions:

- `<ReasoningBlock>` — collapsible. Streams `reasoning_content` chunks during the thinking phase. Auto-collapses to `> Reasoning (Nm Ns)` when the content stream begins. Toggleable via keyboard.
- `<ContentStream>` — the final answer. Renders incrementally with the streaming Markdown parser.

### U2 — Streaming Markdown is O(n)

`ui/markdown/incrementalParser.ts` maintains a stateful tokenizer between chunks. It identifies completed Markdown blocks (paragraphs, fenced code, headings) and locks them; only the still-open trailing block is re-parsed on each chunk. **Do not call a stateless Markdown library on the accumulated buffer per chunk** — that's O(n²) and will block the event loop on long DeepSeek outputs.

### U3 — Clack for onboarding only

Use `@clack/prompts` (`select`, `confirm`, `text`, `spinner`) for the pre-Ink onboarding flow: model selection, API key entry, project scope. Once the agent loop starts, all UI is Ink. Do not mix Clack prompts mid-Ink-render.

### U4 — Logger never writes to stdout

`util/logger.ts` writes to `.myceliate/logs/`, never to `process.stdout` or `process.stderr` while Ink is mounted. Mixing log output with Ink rendering produces ANSI corruption.

---

## Code Conventions

- One responsibility per file. If a file exceeds ~250 lines, consider splitting.
- Imports use explicit `.js` extensions (`import { foo } from './foo.js'`) per NodeNext.
- `import type` for type-only imports (Biome enforces).
- No `any`. Use `unknown` + a Zod parse at the boundary.
- No default exports for modules with > 1 named entity.
- React components use function syntax, not class.
- Async iterators preferred over EventEmitter for streams.
- Errors are typed (`class FooError extends Error`) and carry `cause`.

---

## Test Discipline

- Vitest. TDD is the default workflow: write failing test → see it fail → implement minimum → see it pass → commit.
- Unit tests live under `tests/unit/` mirroring `src/` structure.
- Integration tests under `tests/integration/` may require Redis (Docker Compose). Mark them `describe.skipIf(!process.env.REDIS_URL)`.
- Streaming code is tested with hand-built `AsyncIterable` fixtures, not by hitting the real DeepSeek endpoint.
- Ink components are tested with `ink-testing-library`.
- Coverage target is informational, not enforced. Cover the parser state machines, compaction logic, and security gates exhaustively; cover UI rendering at the smoke level.

---

## Deferred to v2 — do not implement these in v1

If you find yourself building any of the following, stop and surface the scope expansion:

- ACE virtual projections (compaction layer 4)
- Structured 9-section auto-compaction (compaction layer 5)
- Dynamic multi-provider routing engine (Groq / Cerebras / Gemini Flash adapters)
- Daemonised heartbeat / cron-style proactive checks
- Full ephemeral execution sandboxing (microVM, `unshare`, gVisor)
- Continuous-learning skill synthesis (Hermes-style)
- MCP server integration
- FTS5 / SQLite memory store
- Worker / QueueEvents dual Redis connection (R6) — `src/queue/worker.ts` currently shares the `getRedis()` singleton across `Worker` and `QueueEvents`. BullMQ recommends separate `Redis` instances to avoid blocking-read deadlocks under load. Acceptable for the v1 vertical slice; production-readiness needs the split.
