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

## Worker (terminal A)

The worker subprocess is auto-spawned by `main()` via `startWorker()` (Phase 14 Task 93), but for explicit visibility you can also run it manually:

- [ ] `pnpm queue:worker` logs `[worker] consuming queue: bash (concurrency=4)`
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

- [ ] No ANSI corruption when the bash worker logs (worker stdio drained via `.resume()` per Phase 14 m2 fix; U4 preserved)
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
