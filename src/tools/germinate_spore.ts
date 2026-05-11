import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { GerminationEvent, StreamEvent } from '../adapters/streamEvent.js';
import type { McpToolResult } from '../mcp/McpClient.js';
import { McpServerCrashedError, McpToolTimeoutError } from '../mcp/McpClient.js';
import type { McpLifecycle } from '../runtime/mcpLifecycle.js';
import type { HitlGate } from '../security/hitlGate.js';
import type { SporeRegistry } from '../spores/SporeRegistry.js';
import { writePin } from '../spores/pinFile.js';
import { parseSkillFrontmatter } from '../spores/skillFrontmatter.js';
import type { ToolRegistry, ToolRunContext } from '../tools/registry.js';
import type { Logger } from '../util/logger.js';
import { noopLogger } from '../util/noopLogger.js';

export const GerminateSporeInputSchema = z.object({ name: z.string().min(1) }).strict();
export type GerminateSporeInput = z.infer<typeof GerminateSporeInputSchema>;

export type GerminateSporeResult = { ok: true; spore: string } | { ok: false; error: string };

export interface GerminateSporeDeps {
  registry: SporeRegistry;
  cwd: string;
  emit: (e: StreamEvent) => void;
  /**
   * Replaces any prior germinated-context section (or appends if none exists).
   * Phase 21 stretch: uses QueryEngine.replaceGerminatedSection to avoid stacking
   * two sector bodies when the model calls germinate_spore twice in one session.
   */
  appendSystemPrompt: (body: string) => void;
  /** Optional logger — when absent, a silent no-op is used. */
  logger?: Logger;
  /**
   * Phase 3 (T27/T28 forward-compat): MCP server lifecycle owner threaded from
   * `bootTools`. T28's `createGerminateSporeTool` will use this to spawn the
   * MCP server after the spore germinates. Optional so existing call-sites
   * (pre-T28) and tests that don't set up MCP infrastructure continue to work.
   */
  mcpLifecycle?: McpLifecycle;
  /**
   * Phase 3 (T27/T28 forward-compat): the local ToolRegistry from `bootTools`.
   * T28 will register MCP tool wrappers here after spawning the server.
   * Optional for the same backwards-compat reasons as `mcpLifecycle`.
   */
  toolRegistry?: ToolRegistry;
  /**
   * Phase 3 (T27/T28 forward-compat): HITL gate for approving MCP tool calls.
   * T28 wires this into each tool wrapper's `run()` function.
   * Optional for the same backwards-compat reasons as `mcpLifecycle`.
   */
  hitlGate?: HitlGate;
}

export interface GerminateSporeTool {
  name: 'germinate_spore';
  description: string;
  inputSchema: typeof GerminateSporeInputSchema;
  handler: (input: GerminateSporeInput) => Promise<GerminateSporeResult>;
}

/**
 * Convert a tool input args object to a short human-readable string for the
 * HitlGate approval UI. Sliced to 80 chars to keep the approval prompt compact.
 */
function summarizeArgs(input: unknown): string {
  return JSON.stringify(input).slice(0, 80);
}

/**
 * Convert an McpToolResult (content array of text/image parts) to a string
 * for the tool_result message. Concatenates text parts; emits a descriptor for
 * image parts so the model understands what the server returned.
 */
function formatMcpResult(result: McpToolResult): string {
  const parts: string[] = [];
  for (const item of result.content) {
    if (item.type === 'text') {
      parts.push(item.text);
    } else if (item.type === 'image') {
      parts.push(`[image: ${item.mimeType}, ${item.data.length} bytes base64]`);
    }
  }
  return parts.join('\n');
}

export function createGerminateSporeTool(deps: GerminateSporeDeps): GerminateSporeTool {
  return {
    name: 'germinate_spore',
    description:
      'Germinate a sector spore — load its SKILL.md body into the orchestrator system prompt, pin it for the project, and unlock its persona roster for spawn_subagent.',
    inputSchema: GerminateSporeInputSchema,
    async handler({ name }) {
      const spore = deps.registry.get(name);
      if (!spore) return { ok: false, error: `unknown spore "${name}"` };

      // Step 2 (Phase 3 — NEW): if target spore has mcp_server AND lifecycle deps
      // are all present, spawn the MCP server and register namespaced tool wrappers.
      // This MUST happen BEFORE body injection (step 3) so the model can immediately
      // call the named tools that the body references.
      if (
        spore.manifest.mcp_server &&
        deps.mcpLifecycle !== undefined &&
        deps.toolRegistry !== undefined &&
        deps.hitlGate !== undefined
      ) {
        const mcpServer = spore.manifest.mcp_server;

        // Step 2a: spawn — idempotent; McpLifecycle returns existing client if alive.
        let client: Awaited<ReturnType<typeof deps.mcpLifecycle.spawn>>;
        try {
          client = await deps.mcpLifecycle.spawn(spore);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { ok: false, error: `Failed to spawn MCP server for "${name}": ${message}` };
        }

        // Step 2b: for each MCP tool, register a namespaced wrapper (if not already present).
        const toolDescriptors = await client.listTools();
        const toolRegistry = deps.toolRegistry;
        const hitlGate = deps.hitlGate;

        for (const descriptor of toolDescriptors) {
          const namespacedName = `${spore.name}_${descriptor.name}`;

          // Idempotent re-germination: skip if wrapper already registered.
          if (toolRegistry.getActiveTools().some((t) => t.name === namespacedName)) {
            continue;
          }

          // Capture loop variables to avoid closure-over-loop issues.
          const rawToolName = descriptor.name;
          const toolInputSchema = descriptor.inputSchema;
          const toolDescription = descriptor.description;
          const sensitiveTools = mcpServer.sensitive_tools;

          toolRegistry.register({
            name: namespacedName,
            description: toolDescription,
            capability: 'execution' as const, // R9 — MCP tools are execution capability
            inputSchema: { kind: 'json-schema', jsonSchema: toolInputSchema },
            run: async (input: unknown, ctx: ToolRunContext): Promise<string> => {
              // Sensitive tool routing: if raw tool name is declared sensitive, prompt HITL.
              if (sensitiveTools.includes(rawToolName)) {
                const verdict = await hitlGate.checkMcp({
                  requestId: ctx.toolUseId,
                  server: spore.name,
                  tool: rawToolName,
                  argsSummary: summarizeArgs(input),
                  reason: 'declared sensitive in spore manifest',
                });
                if (!verdict.allowed) {
                  return JSON.stringify({ ok: false, error: verdict.feedback });
                }
              }

              // Call the MCP server tool, handling crash and timeout gracefully.
              try {
                const result = await client.callTool(rawToolName, input as Record<string, unknown>);
                return formatMcpResult(result);
              } catch (err) {
                if (err instanceof McpServerCrashedError || err instanceof McpToolTimeoutError) {
                  return JSON.stringify({ ok: false, error: err.message });
                }
                throw err;
              }
            },
          });
        }
        // Step 2c: no teardown of prior MCP-spores — multi-active per §5.1.6.
        // Previously-germinated spores' wrappers stay registered.
      }

      // Step 3: read SKILL.md body and inject into orchestrator system prompt.
      // Ordering: wrappers registered ABOVE (step 2) before body injection here
      // so the model can immediately call the named tools the body references.
      const sectorRaw = await readFile(spore.sectorSkillPath, 'utf8');
      const { body } = parseSkillFrontmatter(sectorRaw);
      const delimited = `\n\n<!-- BEGIN GERMINATED SPORE: ${spore.name} -->\n${body.trim()}\n<!-- END GERMINATED SPORE: ${spore.name} -->\n`;
      deps.appendSystemPrompt(delimited);

      // Step 4: write pin.
      await writePin(deps.cwd, spore.name, deps.logger ?? noopLogger);

      // Step 5: emit germination event.
      const event: GerminationEvent = {
        type: 'germination',
        spore: spore.name,
        accent_color: spore.manifest.accent_color,
        message: `Germinating ${spore.name} spore`,
      };
      deps.emit(event);

      return { ok: true, spore: spore.name };
    },
  };
}
