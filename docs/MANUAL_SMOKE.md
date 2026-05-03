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

HITL smoke (DEFERRED — no bash tool registered in v1; these items will not trigger):
- [ ] [DEFERRED — no bash tool in v1] Prompt `"delete /tmp/foo recursively"` triggers the approval prompt
- [ ] [DEFERRED] Pressing `n` rejects; the agent receives the rejection and recalibrates
- [ ] [DEFERRED] Pressing `y` approves; the command (in a safe sandbox path) executes

Compaction smoke:
- [ ] Set `WORKING_TOKEN_BUDGET=2000` and feed the agent a task that reads several files
- [ ] Logs show compaction actions (`prune` then `snip` then `micro`) as the budget tightens

Note any FAIL items as new tasks; do not mark this checklist complete until every item is checked.
