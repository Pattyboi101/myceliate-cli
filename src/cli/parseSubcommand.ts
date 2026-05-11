// src/cli/parseSubcommand.ts
//
// Unified argv parser for myceliate CLI.  Returns a discriminated union so
// src/index.ts can dispatch on kind without running incompatible flag parsers
// in sequence.
//
// Phase 3 (Exoenzyme): introduces the `mcp-install` branch and subsumes the
// old `parseResumeFlag` / `parseNoSporeFlag` standalone exports from
// src/runtime/resume.ts — those are deleted as public exports and their logic
// lives here instead.

export type Subcommand =
  | { kind: 'interactive'; resumeId?: string; noSpore: boolean }
  | {
      kind: 'mcp-install';
      name: string;
      command: string;
      args: string[];
      env: Record<string, string>;
      regenerate: boolean;
    };

/**
 * Parse process.argv.slice(2) into a Subcommand.
 *
 * Dispatch rules:
 *   argv[0] === 'mcp' && argv[1] === 'install'  → mcp-install branch
 *   anything else                                → interactive branch
 *
 * Interactive flags (subsumed from Phase 18 parseResumeFlag / parseNoSporeFlag):
 *   --resume <id>   → resumeId (throws if id missing or starts with --)
 *   --no-spore      → noSpore: true
 *
 * mcp-install flags:
 *   argv[2]             → name (required — positional after 'mcp install')
 *   --command <cmd>     → command (required; throws if absent)
 *   --arg <a>           → args[] (repeatable, collected in order)
 *   --env KEY=VAL       → env{} (repeatable, split on first '=')
 *   --regenerate        → regenerate: true
 */
export function parseSubcommand(argv: readonly string[]): Subcommand {
  if (argv[0] === 'mcp' && argv[1] === 'install') {
    return parseMcpInstall(argv.slice(2));
  }
  return parseInteractive(argv);
}

// ─── Interactive branch ────────────────────────────────────────────────────────

function parseInteractive(argv: readonly string[]): Extract<Subcommand, { kind: 'interactive' }> {
  // --resume <id>
  const resumeIdx = argv.indexOf('--resume');
  let resumeId: string | undefined;
  if (resumeIdx !== -1) {
    const id = argv[resumeIdx + 1];
    if (!id || id.startsWith('--')) {
      throw new Error('--resume requires a session-id argument (e.g., --resume abc-123)');
    }
    resumeId = id;
  }

  // --no-spore
  const noSpore = argv.includes('--no-spore');

  const result: Extract<Subcommand, { kind: 'interactive' }> = { kind: 'interactive', noSpore };
  if (resumeId !== undefined) {
    result.resumeId = resumeId;
  }
  return result;
}

// ─── mcp-install branch ────────────────────────────────────────────────────────

function parseMcpInstall(rest: readonly string[]): Extract<Subcommand, { kind: 'mcp-install' }> {
  // rest[0] is the name (positional argument after 'mcp install')
  const name = rest[0];
  if (!name || name.startsWith('--')) {
    throw new Error(
      'Usage: myceliate mcp install <name> --command <command> [--arg <arg>]... [--env KEY=VAL]... [--regenerate]',
    );
  }

  const flags = rest.slice(1);
  let command: string | undefined;
  const args: string[] = [];
  const env: Record<string, string> = {};
  let regenerate = false;

  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    if (flag === '--command') {
      const val = flags[i + 1];
      if (!val || val.startsWith('--')) {
        throw new Error('--command requires a value (e.g., --command npx)');
      }
      command = val;
      i++;
    } else if (flag === '--arg') {
      const val = flags[i + 1];
      if (val === undefined) {
        throw new Error('--arg requires a value');
      }
      args.push(val);
      i++;
    } else if (flag === '--env') {
      const val = flags[i + 1];
      if (!val || val.startsWith('--')) {
        throw new Error('--env requires a KEY=VAL value');
      }
      const eqIdx = val.indexOf('=');
      if (eqIdx === -1) {
        throw new Error(`--env value must be in KEY=VAL form, got: ${val}`);
      }
      const key = val.slice(0, eqIdx);
      const envVal = val.slice(eqIdx + 1);
      env[key] = envVal;
      i++;
    } else if (flag === '--regenerate') {
      regenerate = true;
    }
    // Unknown flags are silently ignored (forward-compatible).
  }

  if (command === undefined) {
    throw new Error('myceliate mcp install requires --command <command> (e.g., --command npx)');
  }

  return { kind: 'mcp-install', name, command, args, env, regenerate };
}
