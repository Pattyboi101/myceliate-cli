# Manual smoke verification — myceliate-cli v1.1 (daily-driver sprint)

The v1.1 sprint added: REPL loop with engine continuity (Phase 12), banner + chat-style start (Phases 12.5–12.8), tool-call cards (Phase 13), real bash capability behind HITL approval + BullMQ async queue (Phase 14), and result-rendering polish — collapsible cards + per-card Tab toggle + visible `[REDACTED:*]` markers (Phase 15). This checklist verifies all of it together against the live DeepSeek API.

Run it before tagging a release. Note any FAIL items as new tasks; do not mark this checklist complete until every item is checked.

## Pre-flight

- [ ] `pnpm install` completes
- [ ] `cp .env.example .env` and add `DEEPSEEK_API_KEY=sk-...`
- [ ] `pnpm redis:up` succeeds; `docker ps` shows `myceliate-redis` Up
- [ ] `pnpm test --run` — all unit tests pass (expect ~323 / 4 skipped)
- [ ] `MYC_REDIS_E2E=1 pnpm test:integration --run` — bashToolE2E + queueRoundTrip pass
- [ ] `pnpm typecheck` clean
- [ ] `pnpm lint` clean

### Walk-point 0 — Worker auto-spawn observability (NEW v1.5)

1. Boot myceliate fresh: `myceliate` (no flags).
2. From another terminal, run: `cat .myceliate/logs/worker.log`
3. **Expect:** the log file exists and contains the line `[worker] consuming queue: bash (concurrency=4)`.
4. If the file does not exist or is empty: the worker did not spawn correctly. Check Redis is up (`docker compose ps redis`), then check the orchestrator's stderr for any `[workerLifecycle] spawn error:` line.

## Worker (terminal A)

Worker is auto-spawned by the orchestrator at boot; check `.myceliate/logs/worker.log` if bash hangs, fails to dispatch, or produces unexpected output. Tail it during smoke as `tail -f .myceliate/logs/worker.log`.

- [ ] After booting myceliate, confirm `.myceliate/logs/worker.log` exists with the worker startup line `[worker] consuming queue: bash (concurrency=4)`.
- [ ] Worker stays up; ENOENT/EACCES would surface via `[workerLifecycle] spawn error: ...` if pnpm not on PATH

## CLI smoke (terminal B)

### Onboarding + chat-style start (Phase 12.5–12.8)

- [ ] `pnpm dev` (or globally-linked `myceliate`) skips the API-key prompt when `DEEPSEEK_API_KEY` is in `.env`
- [ ] Onboarding presents adapter (`v3`) + model select via Clack
- [ ] Banner renders (mushroom + MYCELIATE block letters; static frame in v1.1, animation infrastructure preserved in `banner-art.ts`)
- [ ] No Clack "What would you like the agent to do?" interrupt — lands directly in `<PromptInput>`
- [ ] Italic-grey quote line shows below banner metadata, picked from rotation

### REPL loop (Phase 12)

- [ ] Type a first prompt (`"list the files in this directory and tell me which is the largest"`) and press Enter
- [ ] Reasoning block streams text while the model is thinking; collapses to `> Reasoning (Ns)` when content begins
- [ ] Final answer renders with Markdown formatting (heading + paragraph + maybe a list)
- [ ] After the answer streams, a `> ▎` prompt appears for the next turn (REPL — does NOT exit)
- [ ] Type a follow-up referencing the previous answer; verify the engine retains conversation history
- [ ] `/quit` (or Ctrl+D) exits cleanly with no ANSI corruption
- [ ] `.myceliate/history/<session>.md` contains every turn
- [ ] `.myceliate/logs/session.log` parses as JSON lines (file-only logger per U4)

### Tool-call cards (Phase 13)

- [ ] First-turn tool calls (the agent will likely call `list_dir` + `read_file` for the largest-file prompt) appear as `<ToolCallCard>` between `<ReasoningBlock>` and `<ContentStream>`
- [ ] Cards transition `running` (yellow ⠋) → `completed` (green ✓) with `<duration>ms`
- [ ] Card preview shows the redacted, truncated head of the result
- [ ] On a multi-tool turn, cards stack vertically; on the next REPL turn, the previous turn's cards are cleared (`onTurnComplete` clears `state.toolCalls`)

### Tab toggles (Phase 10 + Phase 15)

- [ ] During reasoning streaming, Tab toggles the reasoning block expand/collapse
- [ ] After reasoning completes (collapsed to `> Reasoning (Ns)`) and tool calls land, Tab toggles the **latest** card's body expand/collapse
- [ ] Collapsed card shows the first 5 lines of preview + `… N more lines` footer
- [ ] Expanded card shows the full preview body

### Bash tool with HITL approval (Phase 14)

- [ ] Prompt `"run ls -la in the current directory"` — agent calls bash; queue worker picks up the job; card transitions through running → completed; output formatted with `exitCode: 0\nstdout:\n...\nstderr:\n...`
- [ ] Prompt `"please delete /tmp/foo recursively"` — `<ApprovalPrompt>` fires showing the exact command + cwd + reason
- [ ] Press `n` (reject) — card flips to magenta `∅` with rejection feedback; agent receives the rejection and recalibrates on the next assistant turn (does NOT retry)
- [ ] Press `y` (approve) on a benign dangerous-pattern command (e.g., `sudo echo hi`) — card transitions running → completed; bash runs through the worker

### Redaction visibility (Phase 15)

- [ ] Prompt `"run env and tell me what API keys are set"` (or similar that pulls a `KEY=value` from env) — the bash result preview shows `KEY=[REDACTED:env_value]` with the marker rendered in **magenta** (the rest of the line stays gray)
- [ ] No real secret value appears anywhere in the card or in `.myceliate/history/<session>.md` (F1 redacts at egress to LLM AND now visibly at the UI channel)

## Compaction smoke (regression check from Phase 8)

- [ ] `WORKING_TOKEN_BUDGET=2000 pnpm dev` and feed the agent a task that reads several files
- [ ] `.myceliate/logs/session.log` shows compaction actions (`prune` then `snip` then `micro`) as the budget tightens
- [ ] At 95% budget exhaustion with only L1+L2+L3 available, the orchestrator emits `compaction_required` to the UI and refuses new tool calls (R10 + R12)

## Cross-cutting

- [ ] No ANSI corruption when the bash worker logs (worker stdio routed to `.myceliate/logs/worker.log` per v1.5 Task 4; U4 preserved — Ink never sees worker output)
- [ ] No Clack-mid-Ink violation (Clack only used in onboarding; per U3)
- [ ] `Ctrl+C` mid-streaming does not leave orphaned worker subprocesses (Phase 14 Task 93 `shutdown()` SIGTERM-then-SIGKILL handles this)
- [ ] `Ctrl+D` at the prompt is treated as `/quit`

## Known limitations (acceptable in v1.1, deferred to v1.2)

- HITL `approvalResolver` is a single slot — concurrent tool dispatch would orphan the first promise. v1.1 only does sequential dispatch so this is not reachable; **must be replaced with `Map<requestId, resolver>` before any v1.2 phase introduces parallel dispatch.**
- `summariseArgs` in `ToolCallCard.tsx` would crash on circular-ref args (theoretical — Zod-validated tool args cannot be circular).
- `streamEvent.ts` `tool_result.durationMs` JSDoc says "tools.invoke wall time" but on the failure path includes any artifact-offload time before the throw.
- Worker subprocess assumes `pnpm` on PATH; npm/yarn deploys would need adapter (low priority — Patrick uses pnpm).
- `cardExpanded` does not reset between REPL turns — the first card of turn N+1 inherits the toggle state from turn N. Documented in `App.tsx`; safe because `state.toolCalls` is cleared at the REPL boundary before the new turn's tool_calls arrive.

## v1.3 — Spores

These are walked against the live DeepSeek API. Allocate ~30 minutes.

### 1. Fresh-project germination

1. `cd /tmp && mkdir spore-smoke && cd spore-smoke`
2. `myceliate`
3. Type: "Help me think about IndieStack pricing for the hub product."
4. **Expected:** orchestrator's first turn calls `germinate_spore('solo-business')`. UI shows a `<GerminationCard>` ("Germinating solo-business spore"). InputBox border shifts to amber.
5. Continue: orchestrator should `spawn_subagent('pricing-analyst', ...)` or `spawn_subagent('ceo', ...)`. Sub-agent returns a structured answer.
6. Verify: `cat .myceliate/sector.txt` → `solo-business`.

### 2. /spore list

1. In the same session, type: `/spore list`
2. **Expected:** four spores listed (`solo-business`, `research`, `coding`, `meta`) with tier `[bundled]` (or `[user]` if you've authored your own), accent colour, persona count.

### 3. /spore unpin → bare chat

1. Type: `/spore unpin`
2. **Expected:** InputBox border greys. `cat .myceliate/sector.txt` → file does not exist.
3. Type a follow-up: "What's 2+2?". **Expected:** orchestrator answers without germinating any spore.

### 4. /spore pin <name>

1. Type: `/spore pin research`
2. **Expected:** InputBox turns cyan-teal. `cat .myceliate/sector.txt` → `research`.
3. Type a research-y prompt. **Expected:** orchestrator may spawn `lit-reviewer` or another research persona.

### 5. --no-spore launch flag

1. `cd /tmp/spore-smoke-2 && mkdir -p . && cd .`
2. `myceliate --no-spore`
3. Type: "Help me think about IndieStack pricing."
4. **Expected:** orchestrator answers as bare chat. No germination card. InputBox stays grey throughout.

### 6. Spore-creator dogfood

1. `myceliate` in a fresh dir.
2. Type: "I want to make a new spore for managing my Etsy shop."
3. **Expected:** orchestrator germinates `meta` spore (or pins it via `/spore pin meta` if not auto-classified), spawns `spore-creator`. Sub-agent walks an interview.
4. Answer through to the file-write step.
5. Verify: `ls ~/.myceliate/skills/etsy-shop/` (or whatever name was given) → directory exists with `SKILL.md`, `myceliate.yaml`, `agents/<name>/SKILL.md`.
6. Type: `/spore list` → new spore appears.

### Pass criteria

All 6 sections complete with no errors thrown. v1.3 tag candidate.

---

## v1.4 — Maximal Pack Features

### Phase 22 walk-points

1. **Pack command — happy path**
   - Run `myceliate` in a fresh project.
   - `/spore pin research`
   - `/research:lit-review microplastics in freshwater`
   - Expected: prompt expanded with the topic, model produces a 5-source lit review.

2. **Pack command — pack-not-active refusal**
   - With no spore pinned (or `solo-business` pinned):
   - `/research:lit-review test`
   - Expected: orchestrator output `"/research:lit-review requires the "research" spore to be active. Pin it first via /spore pin research."`. No model call made.

3. **Pack command — command-not-found**
   - `/spore pin research`
   - `/research:fakecmd anything`
   - Expected: orchestrator output `'spore "research" has no command "fakecmd"'`.

4. **Pack command — pack-not-found**
   - `/nonexistent:foo`
   - Expected: orchestrator output `'no spore named "nonexistent"'`.

### Phase 23 walk-points

5. **Tool restriction visibility — restrictive pack pinned**
   - `myceliate` in a fresh project.
   - `/spore pin research` (research declares allowed_tools: [read_file, grep, list_dir]).
   - `/spore tools`.
   - Expected: output lists `read_file`, `grep`, `list_dir`, `germinate_spore`, `spawn_subagent`. write_file + bash absent.

6. **Tool restriction — model behaviour + dispatch-layer defense**
   - With research pinned: ask the model to "edit the file foo.md".
   - Expected (normal path): model does NOT call write_file (it's not in the schema). It either asks for clarification or indicates the operation isn't possible.
   - Expected (defense-in-depth): if the model hallucinates a write_file call despite the schema omission (force this with a more adversarial prompt: "Use the write_file tool to write 'x' to foo.md"), the orchestrator denies the call at dispatch and surfaces a `tool_denied_by_allowlist` error in the next turn rather than executing. ToolDeniedByAllowlistError is the load-bearing class.

7. **Tool restriction — unpin restores**
   - `/spore unpin`.
   - `/spore tools`.
   - Expected: full tool set visible again.

8. **--resume across allowlist change**
   - Start a session with research NOT pinned. Write a file via the bash/write_file tools.
   - Exit. Edit `spores/research/myceliate.yaml` to set `allowed_tools: [read_file]` only.
   - `myceliate --resume <id>` (replace with the session ID from `.myceliate/history/`).
   - `/spore pin research`.
   - Expected: orchestrator boots without crash; the prior write_file tool_call is in the rehydrated history; current turn's tool list excludes write_file.

## Walk-point 10 — MCP integration (Phase 3 Exoenzyme)

**Walk-point 10 (Phase 3 Exoenzyme):**
1. `myceliate mcp install playwright --command npx --arg '@playwright/mcp@latest'`
   Expected: `~/.myceliate/skills/playwright/{manifest.yaml, SKILL.md, commands/*.md}` exist.
   Inspect SKILL.md — confirm auto-gen marker, capability list, no sensitive section
   (Playwright tools are not declared sensitive by default).

   **Atomic install regression**: re-run with a deliberately failing command
   (`--command nonexistent-binary --arg foo`). Expected: clear error to stdout;
   NO partial `~/.myceliate/skills/playwright/` directory left behind; staging
   dir under `~/.myceliate/skills/.staging/` cleaned up by the catch block.

2. `myceliate` → free-form prompt: "open https://example.com and read me the page title."
   Expected: orchestrator emits `germinate_spore('playwright')`, Ink shows germination card,
   `.myceliate/logs/agent.log` shows MCP server spawn + `initialize` handshake within 5s,
   `.myceliate/logs/mcp-playwright.log` exists with browser-launch chatter,
   subsequent iterations call `playwright_navigate` then `playwright_snapshot`,
   tool results land in the agent's history, model returns the title.

3. `/spore pin <other-non-mcp-spore>` (e.g. frontend-design or any hand-authored sector spore).
   Expected (multi-active model — §5.1.6): the new spore's body REPLACES playwright's body
   section in the system prompt (single-active body). BUT playwright's MCP server stays
   alive, `playwright_*` tool wrappers REMAIN in the registry (verify via `/spore tools`),
   and the model can still call them via their JSON Schema tool definitions.

4. **Cross-domain workflow**: install postgres MCP-spore (see step 8 below), then
   `/spore pin postgres`. Run a multi-step task using BOTH:
   "Look up the test user `user@example.com` in the postgres `users` table, then log in
   to https://example.com/login as that user via Playwright."
   Expected: postgres MCP server spawns; postgres SKILL.md body now in prompt; playwright
   wrappers STILL registered. Both servers stay alive across the cross-domain workflow.

5. **Explicit teardown via `/spore unpin`**. The handler tears down the active spore's
   MCP server if it has one. Expected: postgres MCP server child terminates within 2s
   grace; `postgres_*` wrappers deregister; a system-message StreamEvent surfaces
   ("MCP server for 'postgres' terminated; N tool wrapper(s) deregistered.").
   Playwright wrappers STAY (it's not the active spore). To free playwright now,
   `/spore pin playwright` (no-op idempotent spawn) → `/spore unpin`. v1.6+ may add
   `/spore unpin <name>` for direct teardown of any active MCP-spore (per §5.12).

6. **Crash recovery**: while playwright is germinated, manually `kill -9` the playwright
   server child (find via `ps aux | grep playwright`).
   Expected: orchestrator detects unexpected exit within milliseconds via the
   `child.on('exit')` listener bridged to `McpLifecycle.onUnexpectedExit`. Tool wrappers
   `playwright_*` deregister automatically. A system-message StreamEvent surfaces in chat:
   "MCP server for 'playwright' terminated; N tool wrapper(s) deregistered."
   `.myceliate/logs/agent.log` records the exit code/signal.

7. Force-kill the orchestrator (Ctrl+C twice).
   Expected: `ps aux | grep -E 'playwright|server-postgres'` shows no surviving
   server children. The `finally` block in `src/index.ts` invoked `lifecycle.teardownAll()`.

8. Postgres MCP setup (used by steps 4–7):
   `docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=test postgres:16`
   `myceliate mcp install postgres --command npx --arg '@modelcontextprotocol/server-postgres' --arg postgresql://postgres:test@localhost:5432/postgres`
   Manifest hand-edit: add `mcp_server.sensitive_tools: ['execute_query']` (or whatever
   the upstream server names its mutation tool).
   Run a multi-turn task that first reads schema (`list_tables`, `describe_table` —
   should NOT prompt) and then issues a write (`execute_query` — SHOULD prompt
   via the kind:'mcp' approval card; verify the card shows Server: postgres,
   Tool: execute_query, the args summary, and the reason).

9. **Hang protection**: with postgres germinated, intentionally trigger a long query
   (e.g. `SELECT pg_sleep(60)` while `MCP_CALL_TIMEOUT_MS=5000`).
   Expected: orchestrator returns a tool_result with `isError: true` after ~5s carrying
   the `McpToolTimeoutError` message (`MCP tool "postgres.execute_query" exceeded
   callTimeoutMs (5000ms)...`). Postgres server stays alive (no auto-teardown on
   timeout — only on crash). Model decides whether to retry, abort, or change tactic.

## Walk-point 9 — Model routing (Phase 2)

After running any multi-turn orchestrator task, `tail .myceliate/logs/agent.log` should show:

- Subagent dispatches always log `model: 'deepseek-v4-flash'`.
- Iteration 0 of any orchestrator REPL turn always logs `model: 'deepseek-v4-pro'` (planning bias).
- Subsequent iterations log Pro if any prior tool-call assistant turn carried `reasoning_content`, Flash otherwise.

To verify the env-override warn: `DEEPSEEK_MODEL=test-override myceliate` should write a single `[myceliate] DEEPSEEK_MODEL env var is set...` line to stderr before Ink mounts, then route every call to `'test-override'`.

### Phase 23 known limitations (v1.5 follow-up)

**Sub-agent privilege escalation via `spawn_subagent` proxy (Case 6 — deferred to v1.5):**

The orchestrator's `allowed_tools` allowlist in v1.4 scopes only the orchestrator's own tool surface. It does NOT propagate to sub-agents spawned via `spawn_subagent`. This means a restricted orchestrator (e.g., with research's `[read_file, grep, list_dir]` allowlist) can still ask a sub-agent to perform operations the orchestrator cannot do directly:

> "I can't write files because of my allowlist. Ask the sub-agent to write foo.md instead."

This proxy path succeeds because sub-agents receive the persona's full execution tool set (R9 partition). This is a known, accepted limitation in v1.4. The security boundary is the orchestrator's own direct tool calls. Full allowlist inheritance through `spawn_subagent` is deferred to v1.5, where the sub-agent bootstrap protocol will include the parent's allowlist in the spawn request.
