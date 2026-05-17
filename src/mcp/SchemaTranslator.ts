// src/mcp/SchemaTranslator.ts
//
// Pure function — given the output of McpClient.listTools() plus the spore's manifest,
// emit the generated SKILL.md body and per-tool commands/*.md content.
//
// No I/O. No side effects beyond logger.warn for the empty-tools edge case.
// Snapshot-testable: fixed input → fixed output.
//
// Naming convention (per §5.4):
//   - commandFiles map key (and frontmatter `name:`) uses the KEBAB-CASE form of the MCP tool
//     name. snake_case names (e.g. browser_navigate) are converted with `_` → `-` so the
//     command-loader's kebab-case validator accepts them.
//   - SKILL.md body capability references use the NAMESPACED form: <spore-name>_<raw-name>,
//     retaining the original MCP tool name for tool registry dispatch.
//   - The frontmatter `name:` field matches the filename basename, satisfying the
//     existing parseSkillFrontmatter validation.

import type { SporeManifest } from '../spores/SporeManifest.js';
import type { Logger } from '../util/logger.js';
import type { McpToolDescriptor } from './McpClient.js';

export const AUTO_GEN_MARKER =
  '<!-- MYCELIATE: AUTO-GENERATED ABOVE; user notes BELOW are preserved on --regenerate -->';

const MAX_FM_DESC_LEN = 200;

const introSentence = (command: string): string =>
  `The platform manages the underlying MCP server lifecycle (${command}). You invoke high-level primitives; the platform speaks the wire protocol.`;

export interface TranslationResult {
  /** Full SKILL.md body (without frontmatter — frontmatter is generated separately
   *  from the manifest). Contains the auto-gen marker per §5.1.2. */
  skillBody: string;
  /** Map of command file name (e.g. "navigate.md") to full file content (frontmatter + body). */
  commandFiles: Map<string, string>;
}

// ─── Public API ────────────────────────────────────────────────────────────────

export function translateMcpSchema(
  tools: McpToolDescriptor[],
  manifest: SporeManifest,
  logger: Logger,
): TranslationResult {
  const sporeName = manifest.name;
  const mcpServer = manifest.mcp_server;
  const command = mcpServer?.command ?? 'unknown';
  const sensitiveTools = new Set(mcpServer?.sensitive_tools ?? []);

  // Edge case: no tools discovered.
  if (tools.length === 0) {
    logger.warn({ msg: 'SchemaTranslator: no tools returned by MCP server', spore: sporeName });
    const skillBody = `# ${manifest.name}\n\n${manifest.description}\n\n${introSentence(command)}\n\n*No capabilities discovered — the MCP server returned an empty tools list.*\n\n${AUTO_GEN_MARKER}\n`;
    return {
      skillBody,
      commandFiles: new Map(),
    };
  }

  // ─── Build SKILL.md body ────────────────────────────────────────────────────

  const capabilityLines: string[] = [];
  for (const tool of tools) {
    const namespacedName = `${sporeName}_${tool.name}`;
    const argSummary = buildArgSummary(tool.inputSchema);
    const callSig = argSummary ? `\`${namespacedName}(${argSummary})\`` : `\`${namespacedName}()\``;
    const line = `- ${callSig} — ${tool.description}`;
    const hierarchy = buildArgHierarchy(tool.inputSchema, 1);
    capabilityLines.push(hierarchy ? `${line}\n${hierarchy}` : line);
  }

  let skillBody = `# ${manifest.name}\n\n${manifest.description}\n\n${introSentence(command)}\n\n## Capabilities\n\n${capabilityLines.join('\n\n')}\n`;

  // Sensitive operations section — only if non-empty intersection.
  const sensitiveInManifest = [...sensitiveTools].filter((t) =>
    tools.some((tool) => tool.name === t),
  );
  if (sensitiveInManifest.length > 0) {
    const sensitiveLines = sensitiveInManifest.map((toolName) => {
      const tool = tools.find((t) => t.name === toolName);
      return `- \`${sporeName}_${toolName}\` — ${tool?.description ?? ''}`;
    });
    skillBody += `\n## Sensitive operations\n\nThe following tools require human approval before each call:\n${sensitiveLines.join('\n')}\n`;
  }

  skillBody += `\n${AUTO_GEN_MARKER}\n`;

  // ─── Build command files ────────────────────────────────────────────────────

  const commandFiles = new Map<string, string>();
  for (const tool of tools) {
    const kebabName = toKebab(tool.name);
    const fileName = `${kebabName}.md`;
    const content = buildCommandFile(tool, kebabName, sporeName, sensitiveTools);
    commandFiles.set(fileName, content);
  }

  return { skillBody, commandFiles };
}

/** Convert snake_case (or any underscore-separated) name to kebab-case. */
function toKebab(name: string): string {
  return name.replace(/_/g, '-').toLowerCase();
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build the argument summary for the SKILL.md capability line.
 * e.g. "url: string" or "query: string, limit?: number"
 */
function buildArgSummary(inputSchema: Record<string, unknown>): string {
  const properties = asObjectRecord(inputSchema.properties);
  if (!properties) return '';
  const required = asStringArray(inputSchema.required);
  const parts: string[] = [];
  for (const [propName, propSchema] of Object.entries(properties)) {
    const typeStr = resolveType(asObjectRecord(propSchema));
    const isRequired = required.includes(propName);
    parts.push(isRequired ? `${propName}: ${typeStr}` : `${propName}?: ${typeStr}`);
  }
  return parts.join(', ');
}

/**
 * Build the one-bullet hierarchy of inputSchema fields for the SKILL.md body.
 * depth=1 → "  - `prop` (type): description"
 * depth=2 → "    - `prop` (type): description"
 * Returns empty string when no properties.
 */
function buildArgHierarchy(inputSchema: Record<string, unknown>, depth: number): string {
  const properties = asObjectRecord(inputSchema.properties);
  if (!properties || Object.keys(properties).length === 0) return '';
  const indent = '  '.repeat(depth);
  const lines: string[] = [];
  for (const [propName, propSchema] of Object.entries(properties)) {
    const schema = asObjectRecord(propSchema);
    const typeStr = resolveType(schema);
    const desc = schema ? ((schema.description as string | undefined) ?? '') : '';
    const descSuffix = desc ? `: ${desc}` : '';
    lines.push(`${indent}- \`${propName}\` (${typeStr})${descSuffix}`);
    // Recurse into nested object properties
    if (schema && typeStr === 'object') {
      const nested = asObjectRecord(schema.properties);
      if (nested && Object.keys(nested).length > 0) {
        const nestedStr = buildArgHierarchy(schema, depth + 1);
        if (nestedStr) lines.push(nestedStr);
      }
    }
  }
  return lines.join('\n');
}

/**
 * Build a single command/*.md file content.
 * Frontmatter name: kebab-case tool name (matches filename, passes parseSkillFrontmatter validation).
 * Body call reference (namespacedName) retains the raw tool name so the tool registry mapping
 * to the MCP server's actual call signature is preserved.
 */
function buildCommandFile(
  tool: McpToolDescriptor,
  kebabName: string,
  sporeName: string,
  sensitiveTools: Set<string>,
): string {
  const namespacedName = `${sporeName}_${tool.name}`;
  const isSensitive = sensitiveTools.has(tool.name);

  // Truncate description to 200 chars for frontmatter
  const fmDesc =
    tool.description.length > MAX_FM_DESC_LEN
      ? tool.description.slice(0, MAX_FM_DESC_LEN)
      : tool.description;

  // Prose summary — capitalise + ensure period.
  const proseSummary = summariseTool(tool.description);

  const frontmatter = `---\nname: ${kebabName}\ndescription: ${fmDesc}\n---\n`;
  const heading = `# ${kebabName}\n`;
  const intro = `Invoked as \`${namespacedName}\`. ${proseSummary}\n`;
  const sensitiveNotice = isSensitive
    ? '\n**Sensitive:** this tool requires human approval before each call.\n'
    : '';

  const argsSection = buildCommandArgsSection(tool.inputSchema);

  return `${frontmatter}\n${heading}\n${intro}${sensitiveNotice}\n${argsSection}`;
}

/**
 * Build the args section for a command/*.md file.
 * If no properties, emits "No arguments required." prose.
 */
function buildCommandArgsSection(inputSchema: Record<string, unknown>): string {
  const properties = asObjectRecord(inputSchema.properties);
  if (!properties || Object.keys(properties).length === 0) {
    return 'No arguments required.\n';
  }
  const required = asStringArray(inputSchema.required);
  const lines: string[] = ['**Arguments:**\n'];
  for (const [propName, propSchema] of Object.entries(properties)) {
    const schema = asObjectRecord(propSchema);
    const typeStr = resolveType(schema);
    const desc = schema ? ((schema.description as string | undefined) ?? '') : '';
    const reqStr = required.includes(propName) ? 'required' : 'optional';
    const descSuffix = desc ? `: ${desc}` : '';
    lines.push(`- \`${propName}\` (${typeStr}, ${reqStr})${descSuffix}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Turn a tool description into a prose sentence (capitalised, ends with period).
 * Uses the description verbatim — no tense rewriting.
 */
function summariseTool(description: string): string {
  const trimmed = description.trim();
  if (!trimmed) return '';
  const capitalised = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return capitalised.endsWith('.') ? capitalised : `${capitalised}.`;
}

/** Resolve the JSON Schema type string. Defaults to "unknown". */
function resolveType(schema: Record<string, unknown> | null): string {
  if (!schema) return 'unknown';
  const t = schema.type;
  if (typeof t === 'string') return t;
  return 'unknown';
}

/** Safe cast to string[]. */
function asStringArray(val: unknown): string[] {
  if (!Array.isArray(val)) return [];
  return val.filter((v): v is string => typeof v === 'string');
}

/** Safe cast to Record<string, unknown>. */
function asObjectRecord(val: unknown): Record<string, unknown> | null {
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    return val as Record<string, unknown>;
  }
  return null;
}
