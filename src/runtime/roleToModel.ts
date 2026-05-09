// src/runtime/roleToModel.ts
import type { Logger } from '../util/logger.js';

/**
 * Spore role tags identify the strategic intent of a single API call. The
 * dispatcher routes mechanical/cloned-execution roles (Anamorph) to V4-Flash
 * and generative/architectural roles (Teleomorph) to V4-Pro.
 *
 * Wired in v1.5 Phase 2: 'subagent', 'repl-execution', 'repl-with-reasoning'.
 * Reserved for explicit future use:
 *   - 'germination' — orchestrator turn invoking germinate_spore (Phase 4
 *     anastomosis hook; today germination is a tool call inside an existing
 *     repl-* role, not its own dispatch site).
 *   - 'orchestrator' — generic orchestrator default for non-REPL flows
 *     (cron spores in v1.6+, programmatic API entry points).
 */
export type SporeRole =
  | 'subagent'
  | 'repl-execution'
  | 'repl-with-reasoning'
  | 'germination'
  | 'orchestrator';

export type AnamorphModel = 'deepseek-v4-flash';
export type TeleomorphModel = 'deepseek-v4-pro';
export type RoutedModel = AnamorphModel | TeleomorphModel;

const ROLE_MAP: Readonly<Record<SporeRole, RoutedModel>> = {
  subagent: 'deepseek-v4-flash', // R8/R9: ephemeral mechanical loop
  'repl-execution': 'deepseek-v4-flash', // tool-loop turn, no retained reasoning
  'repl-with-reasoning': 'deepseek-v4-pro', // R2 cumulative reasoning in flight
  germination: 'deepseek-v4-pro', // strategic spore-discovery / pre-pin
  orchestrator: 'deepseek-v4-pro', // generic orchestrator-side default
};

/**
 * Resolve the model string for a given role.
 *
 * Precedence:
 *   1. `DEEPSEEK_MODEL` env var (if non-empty) — bypasses role routing entirely.
 *      Documented escape hatch for local-mock testing, incident response, and
 *      pre-release variant testing.
 *   2. `ROLE_MAP[role]` — the canonical Anamorph/Teleomorph mapping.
 *
 * Pure function modulo `process.env`. Logger arg is intentionally absent —
 * the env-override warn is fired exactly once at boot via
 * `checkAndWarnEnvOverride()`, not lazily on each call.
 *
 * Returns `string`, not `RoutedModel`, because the env override may be any
 * string (deepseek-reasoner for V3 testing, ollama:* for local mocks).
 */
export function roleToModel(role: SporeRole): string {
  const envOverride = process.env.DEEPSEEK_MODEL;
  if (envOverride !== undefined && envOverride.length > 0) return envOverride;
  return ROLE_MAP[role];
}

/**
 * Boot-time check: emit an unmissable warn if DEEPSEEK_MODEL is set.
 *
 * Called from `main()` in src/index.ts BEFORE Ink mounts, so writing to
 * stderr is U4-safe. Also emits a structured log record via the supplied
 * logger.
 *
 * Idempotent if invoked twice (no-harm second call). Writes are silent
 * when the env var is unset.
 */
export function checkAndWarnEnvOverride(logger: Logger): void {
  const envOverride = process.env.DEEPSEEK_MODEL;
  if (envOverride === undefined || envOverride.length === 0) return;
  const message = `DEEPSEEK_MODEL env var is set. Bypassing Anamorph/Teleomorph role routing and forcing model: ${envOverride}`;
  logger.warn({ event: 'deepseek_model_override', model: envOverride });
  process.stderr.write(`[myceliate] ${message}\n`);
}
