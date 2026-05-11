// src/cli/mcpInstall.ts
//
// Atomic install flow for `myceliate mcp install`.
//
// Phase 3 (Exoenzyme) §5.6: connects to an MCP server, introspects its tool
// list, writes manifest.yaml + SKILL.md + commands/*.md into a staging dir,
// then atomically moves the staging dir to the final target using POSIX
// rename(2).  Any failure in the middle cleans up the staging dir and re-throws
// so no partial install is ever left at the target path.

import { existsSync, readFileSync, renameSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { stringify as yamlStringify } from 'yaml';
import { createMcpClient } from '../mcp/McpClient.js';
import type { McpToolDescriptor } from '../mcp/McpClient.js';
import { translateMcpSchema } from '../mcp/SchemaTranslator.js';
import type { SporeManifest } from '../spores/SporeManifest.js';
import { createLogger } from '../util/logger.js';
import type { Logger } from '../util/logger.js';

// The auto-gen marker (must match SchemaTranslator.ts exactly).
const AUTO_GEN_MARKER =
  '<!-- MYCELIATE: AUTO-GENERATED ABOVE; user notes BELOW are preserved on --regenerate -->';

export interface McpInstallOpts {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  regenerate: boolean;
  /** Optional logger; a no-op logger is used if absent. */
  logger?: Logger;
}

/**
 * Programmatically-callable entry point for the mcp install flow.
 * The CLI calls this after `parseSubcommand` dispatches to `mcp-install`.
 * Tests call it directly, with a tmp HOME override via process.env.HOME.
 */
export async function runMcpInstall(opts: McpInstallOpts): Promise<void> {
  const { name, command, args, env, regenerate } = opts;

  // Use caller-supplied logger or create a silent one (no-op to stdout/stderr).
  const logger = opts.logger ?? createLogger({ logsDir: join(homedir(), '.myceliate', 'logs') });

  // ─── Step 1: resolve target dir ────────────────────────────────────────────

  const home = process.env.HOME ?? homedir();
  const skillsRoot = join(home, '.myceliate', 'skills');
  const targetDir = join(skillsRoot, name);

  if (existsSync(targetDir) && !regenerate) {
    throw new Error(
      `Skill directory already exists at ${targetDir}.\nRe-run with --regenerate to overwrite the auto-generated content (user notes below the marker are preserved).`,
    );
  }

  // Read existing SKILL.md below-marker content before we blow away the target.
  let belowMarkerContent = '';
  if (regenerate && existsSync(targetDir)) {
    const existingSkillMd = join(targetDir, 'SKILL.md');
    if (existsSync(existingSkillMd)) {
      const raw = readFileSync(existingSkillMd, 'utf-8');
      const markerIdx = raw.indexOf(AUTO_GEN_MARKER);
      if (markerIdx !== -1) {
        // Preserve everything after the marker line.
        const afterMarker = raw.slice(markerIdx + AUTO_GEN_MARKER.length);
        belowMarkerContent = afterMarker;
      }
    }
  }

  // ─── Step 2: create staging dir ────────────────────────────────────────────

  const stagingRoot = join(skillsRoot, '.staging');
  const timestamp = Date.now();
  const stagingDir = join(stagingRoot, `${name}-${timestamp}`);
  await mkdir(stagingDir, { recursive: true });

  // ─── Steps 3-9: wrapped in try/catch for atomic cleanup ────────────────────

  try {
    // Step 3-6: connect, initialize, listTools, close.
    const client = createMcpClient({
      command,
      args,
      env,
      logger,
      serverName: name,
      initializeTimeoutMs: Number(process.env.MCP_INITIALIZE_TIMEOUT_MS) || 5000,
    });

    await client.initialize();
    const tools: McpToolDescriptor[] = await client.listTools();
    await client.close();

    // Step 7: construct manifest.
    // description: use a clear identifiable fallback; could be extended to use
    // serverInfo if the MCP SDK exposes it post-initialize.
    const description = `MCP-translated spore for ${name}`;
    // accent_color: deterministic hash of name → 6-digit hex (keeps the color
    // stable across re-installs so the TUI banner stays consistent).
    const accent_color = deriveAccentColor(name);

    const manifest: SporeManifest = {
      name,
      description,
      version: '0.1.0',
      accent_color,
      keywords: [],
      agents: [],
      // allowed_tools uses the NAMESPACED form per §5.6 step 7.
      allowed_tools: tools.map((t) => `${name}_${t.name}`),
      mcp_server: {
        command,
        args,
        env,
        sensitive_tools: [],
      },
    };

    // Step 8: translate schema and write files into staging dir.
    const { skillBody, commandFiles } = translateMcpSchema(tools, manifest, logger);

    // Write manifest.yaml
    const manifestYaml = yamlStringify(manifest);
    await writeFile(join(stagingDir, 'manifest.yaml'), manifestYaml, 'utf-8');

    // Build SKILL.md frontmatter
    const skillFrontmatter = buildSkillFrontmatter(name, description);

    // Merge below-marker user content if regenerating
    const mergedBelowMarker = belowMarkerContent;
    const skillMdContent = `${skillFrontmatter}\n${skillBody}${mergedBelowMarker}`;
    await writeFile(join(stagingDir, 'SKILL.md'), skillMdContent, 'utf-8');

    // Write commands/*.md
    if (commandFiles.size > 0) {
      const commandsDir = join(stagingDir, 'commands');
      await mkdir(commandsDir, { recursive: true });
      for (const [fileName, content] of commandFiles) {
        await writeFile(join(commandsDir, fileName), content, 'utf-8');
      }
    }

    // Step 9: atomic move — POSIX rename(2) is atomic on same filesystem.
    // If regenerating with an existing target, remove it first.
    if (regenerate && existsSync(targetDir)) {
      await rm(targetDir, { recursive: true, force: true });
    }

    // Ensure skillsRoot exists before rename (staging already created it, but
    // targetDir's parent is skillsRoot which was created by mkdir above).
    renameSync(stagingDir, targetDir);

    // Step 10: success output.
    const capCount = tools.length;
    console.log(
      `Installed ${name} → ${targetDir}\n` +
        `  ${capCount} ${capCount === 1 ? 'capability' : 'capabilities'} installed.\n` +
        `  Now run \`myceliate\` and germinate ${name}.`,
    );
  } catch (err) {
    // Cleanup: remove staging dir on any failure.
    await rm(stagingDir, { recursive: true, force: true });
    throw err;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build SKILL.md frontmatter block.
 * The `name` field must match the directory basename (kebab-case).
 * The `description` is truncated to 200 chars per SkillFrontmatterSchema.
 */
function buildSkillFrontmatter(name: string, description: string): string {
  const fmDesc = description.length > 200 ? description.slice(0, 200) : description;
  return `---\nname: ${name}\ndescription: ${fmDesc}\n---\n`;
}

/**
 * Derive a deterministic 6-digit hex accent color from the spore name.
 * Uses a simple djb2-variant hash → maps to the range #204060..#dfffff
 * (avoids very dark or very light extremes) so the TUI banner is readable.
 */
function deriveAccentColor(name: string): string {
  let hash = 5381;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) + hash) ^ name.charCodeAt(i);
    hash = hash >>> 0; // keep unsigned 32-bit
  }
  // Map to 0x200000..0xdfffff to avoid near-black / near-white colors.
  const base = 0x200000;
  const range = 0xdfffff - base;
  const value = base + (hash % range);
  return `#${value.toString(16).padStart(6, '0').slice(0, 6)}`;
}
