# myceliate-cli

Autonomous CLI agent built against the DeepSeek V4 API spec, runnable today via a V3-reasoner adapter.

Implements the **Thin Agent / Fat Platform** paradigm: a central orchestrator manages state, security, and the ReAct loop; ephemeral sub-agents execute narrow, stateless tasks.

## Architecture (vertical slice — v1)

- **Adapter layer** — strict `DeepSeekClient` interface shaped to V4 (Thinking Mode, `reasoning_content` retention across tool calls, DSML `<|DSML|tool_calls>` parsing, strict-mode JSON Schema). Two adapters behind it: `v3` (works today against `deepseek-reasoner`) and `v4` (DSML state machine, ready to swap in).
- **Background tasks** — heavy I/O (`bash`, `docker build`, test suites) is dispatched to BullMQ jobs backed by Redis. Worker uses `child_process.spawn`, never blocks the main event loop. Notification bridge re-injects results into the ReAct loop.
- **Memory** — OpenClaw-style file-backed Markdown persistence under `.myceliate/`. Version-controllable, diff-able, no database.
- **TUI** — Ink for the dual-stream layout (collapsible `<ReasoningBlock>` + final `<ContentStream>`) with incremental Markdown parsing (O(n) streaming). Clack for onboarding (select/confirm).
- **Security** — static-regex secret redaction at the egress boundary; HITL approval gate for high-risk shell ops.
- **Compaction** — layers 1–3 (budget pruning, history snipping, cache-aware micro-compaction). Layers 4–5 (ACE virtual projections, structured 9-section auto-compaction) are deferred to v2.

See [`CLAUDE.md`](./CLAUDE.md) for architectural constraints and [`docs/superpowers/plans/`](./docs/superpowers/plans/) for the implementation plan.

## Setup

```bash
pnpm install        # or npm install
cp .env.example .env
# Add DEEPSEEK_API_KEY to .env
pnpm redis:up       # start Redis via docker compose
pnpm queue:worker   # in one terminal — runs the BullMQ consumer
pnpm dev            # in another — runs the agent
```

## Deferred to v2

- Compaction layers 4 (ACE) and 5 (structured 9-section auto-compaction)
- Dynamic multi-provider routing (Groq / Cerebras / Gemini Flash)
- Daemon heartbeat + cron-style proactive checks
- Full ephemeral execution sandboxing (microVM / unshare)
