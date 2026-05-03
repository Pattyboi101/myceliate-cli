# Resume — Myceliate CLI v1.1 sprint

**Paste this into a fresh Claude Code session at `~/Myceliate/myceliate-cli` to pick up exactly where we left off.**

---

You're resuming work on Myceliate CLI's v1.1 daily-driver sprint. The codebase is at `~/Myceliate/myceliate-cli` and the project memory at `~/.claude/projects/-home-patty-Myceliate/memory/` should auto-load — read `project_myceliate.md` first for the full context.

## Current state (as of pause)

- **Branch**: `main`. Two ultra-recent merges:
  - `5bbb3dc` Phase 12 — REPL loop + dotenv + local-history redaction (Tasks 81-85)
  - `b4e545c` Phase 12.5 — chat-style start with neon-blue mushroom banner
- **Tests**: 303 unit pass / 2 Redis-integration skipped. typecheck + lint clean across 95 files.
- **Live API**: V3 adapter verified end-to-end against DeepSeek (`scripts/smoke-live-v3.ts`). F1 redaction works on the wire.
- **`.env`**: real `DEEPSEEK_API_KEY` is in `~/Myceliate/myceliate-cli/.env` with `chmod 600`. Auto-loaded via `loadDotenv()` at process start.

## Sidetrack in progress

Patrick paused mid-sprint to redo the durdraw banner art at full scale. The existing source at `~/Myceliate/myceliate_title` is an 80×23 canvas with art occupying the top 9 rows — too narrow for the chat-style start to feel impactful. He's redrawing at something like **140×16** or **160×20** via:

```bash
durdraw -W 160 -H 20 ~/Myceliate/myceliate_title
# ...redraw...
# Ctrl+S to save (overwrite)
```

Palette is xterm-256 colours **16-21** (dark→neon blue ramp) plus **255** (near-white) plus **7** (silver). That's what the current art uses — the generator at `scripts/build-banner.ts` only knows those entries. If Patrick adds new colours, the generator's `PALETTE` map needs the new entries before regenerating.

## When the new art is saved, do this

1. **Regenerate the Ink module** from the new durdraw file:
   ```bash
   cd ~/Myceliate/myceliate-cli && pnpm tsx scripts/build-banner.ts
   ```
   This rewrites `src/ui/banner-art.ts` with the new rows + colour-runs.

2. **Visual smoke** — run `pnpm dev` and confirm:
   - Banner renders without ANSI corruption
   - Width fits the terminal (no wraps)
   - Metadata line (`<model>  ·  <ADAPTER> adapter  ·  <cwd>`) appears below
   - `> ▎` PromptInput sits below the metadata with `/quit or Ctrl+D to exit` hint

3. **If anything looks off**:
   - The generator only handles xterm-256 colours listed in its `PALETTE` map. Unknown indices fall back to `#ffffff`. Add missing colours to `scripts/build-banner.ts` if needed and regenerate.
   - Banner is 80→160+ cols. Patrick's terminal must be at least that wide or rows wrap. Current `<Banner>` doesn't truncate or scale.

4. **Commit the regenerated art**:
   ```bash
   git checkout -b feat/phase-12.6-bigger-banner
   git add src/ui/banner-art.ts ~/Myceliate/myceliate_title
   # The myceliate_title file lives outside the repo at ~/Myceliate/, so
   # only banner-art.ts is in the repo's git tree. The source .dur file
   # is implicitly versioned by Patrick keeping it locally.
   GIT_AUTHOR_NAME='Patrick' GIT_AUTHOR_EMAIL='amey-jonesp@cardiff.ac.uk' \
   GIT_COMMITTER_NAME='Patrick' GIT_COMMITTER_EMAIL='amey-jonesp@cardiff.ac.uk' \
   git commit -m "feat(ui): regenerate banner art at full scale (Phase 12.6)"
   git checkout main
   GIT_AUTHOR_NAME='Patrick' GIT_AUTHOR_EMAIL='amey-jonesp@cardiff.ac.uk' \
   GIT_COMMITTER_NAME='Patrick' GIT_COMMITTER_EMAIL='amey-jonesp@cardiff.ac.uk' \
   git merge --no-ff feat/phase-12.6-bigger-banner -m "Merge: Phase 12.6 — full-scale banner art"
   ```

## After the banner sidetrack — Phase 13

Pick up the v1.1 sprint plan at `docs/superpowers/plans/2026-05-04-v1.1-daily-driver-sprint.md`. **Phase 13 is next**: `tool_result` StreamEvent + UI tool-call cards.

Cadence (mirror the Phase 12 playbook documented in memory):

1. Branch `feat/phase-13-tool-cards` off main.
2. Dispatch ONE fresh sonnet subagent (`general-purpose`, `model: sonnet`) to execute all of Phase 13 (Tasks 86-90). Use the exact implementer-prompt structure from this conversation's history. **Critical addition baked in from the Phase 12 process gap**: the implementer prompt MUST include an explicit `git status` clean-tree check at the end of every task and at phase completion. Phase 12's implementer used `git commit -am` and left three new files untracked — that mistake cannot be allowed to repeat.
3. Two-stage parallel review: dispatch two fresh sonnet subagents (spec-conformance + code-quality) in `run_in_background: true` mode. Reviewer prompts must include: `find` for files imported by tests but absent from git (catches the untracked-files class of bug).
4. Apply MAJOR/MINOR fixes inline as a single commit `fix(phase-13): apply review feedback (...)`. Plan-defect notes go in the merge message and project_myceliate.md memory entry.
5. `--no-ff` merge into main with comprehensive summary message (mirror Phase 12's merge `5bbb3dc` style).
6. Update memory: add Phase 13 entry to `project_myceliate.md` with merge SHA, test counts, plan-defect fixes, review findings.

Phase 14 (bash tool with HITL + BullMQ) and Phase 15 (result rendering polish) follow the same playbook.

## Key project rules to honour (CLAUDE.md, never deviate)

- **R11**: every LLM payload through `redactSecrets`; conversation log on disk now also redacted (Phase 12 Task 81a).
- **R10/R12**: compaction L1→L2→L3 unconditional, then refuse at 95%. Don't change.
- **U3**: no Clack mid-Ink-render. PromptInput uses Ink `useInput`, not Clack.
- **U4**: logger never writes to stdout while Ink is mounted.
- **Per-phase branches with `--no-ff` summary merges**, no worktrees.
- **No `!` non-null assertions**, no `as any`, no shortcuts on strict TypeScript.
- **TDD discipline**: failing test first, then implementation, then green.

## Deferred to v1.2 (do NOT implement these in Phase 13/14/15)

Session resume by id, slash commands beyond `/quit`, JIT skill auto-load, subagent spawning, `write_file` diff rendering, syntax highlighting, **V4 ThinkingOptions wire-shape fix (F7)**, compaction-then-redact integration test, `dirEntries` filename filter.

## Files to read on session start

1. `~/.claude/projects/-home-patty-Myceliate/memory/MEMORY.md` (auto-loaded index)
2. `~/.claude/projects/-home-patty-Myceliate/memory/project_myceliate.md` (full project state)
3. `~/Myceliate/myceliate-cli/CLAUDE.md` (architectural rules R1-R12, U1-U4, deferred-to-v2 list)
4. `~/Myceliate/myceliate-cli/docs/superpowers/plans/2026-05-04-v1.1-daily-driver-sprint.md` (the plan)
5. `git log --oneline -10` on main to verify current SHA matches the memory record (memory can drift)

Begin.
