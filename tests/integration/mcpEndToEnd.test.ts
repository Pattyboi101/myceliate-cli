// tests/integration/mcpEndToEnd.test.ts
//
// End-to-end "translation reaches the wire" assertion per spec §5.9.
//
// Strategy: use the REAL fake-server + REAL McpLifecycle for the wire path,
// with a recording DeepSeek adapter that emits a tool_call against
// fake-spore_echo on iteration 0. Asserts:
//   (a) recording adapter saw fake-spore_echo in tool definitions sent to LLM;
//   (b) the tool_call landed on the real MCP server (verified via the
//       fake-server's response shape: { tool, args });
//
// Does NOT require Redis. REAL fake-server child process IS spawned.

import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatRequest, DeepSeekClient } from '../../src/adapters/DeepSeekClient.js';
import type { StreamEvent } from '../../src/adapters/streamEvent.js';
import { runMcpInstall } from '../../src/cli/mcpInstall.js';
import { QueryEngine } from '../../src/orchestrator/QueryEngine.js';
import { runReactLoop } from '../../src/orchestrator/reactLoop.js';
import { McpLifecycle } from '../../src/runtime/mcpLifecycle.js';
import { HitlGate } from '../../src/security/hitlGate.js';
import type { Spore } from '../../src/spores/Spore.js';
import { SporeRegistry } from '../../src/spores/SporeRegistry.js';
import { createGerminateSporeTool } from '../../src/tools/germinate_spore.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import type { Logger } from '../../src/util/logger.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const FAKE_SERVER = resolve(
  import.meta.dirname ?? new URL('.', import.meta.url).pathname,
  '../fixtures/mcp/fake-server.mjs',
);

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  flush: async () => {},
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a Spore object directly from the install output, bypassing
 * SporeRegistry.discover(). This is a test-fixture shortcut to keep the
 * end-to-end test simple — production code uses discover() at boot.
 */
function buildFakeSpore(sporeDir: string): Spore {
  return {
    name: 'fake-spore',
    tier: 'user',
    dir: sporeDir,
    manifest: {
      name: 'fake-spore',
      description: 'MCP-translated spore for fake-spore',
      version: '0.1.0',
      accent_color: '#abcdef',
      keywords: [],
      agents: [],
      allowed_tools: ['fake-spore_echo', 'fake-spore_add', 'fake-spore_greet'],
      mcp_server: {
        command: 'node',
        args: [FAKE_SERVER],
        env: {},
        sensitive_tools: [],
      },
    },
    sectorFrontmatter: { name: 'fake-spore', description: 'MCP-translated spore for fake-spore' },
    sectorSkillPath: join(sporeDir, 'SKILL.md'),
    personas: [],
    commands: [],
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('MCP end-to-end: translation reaches the wire', () => {
  let tmpHome: string;
  let logsDir: string;
  let origHome: string | undefined;
  let lifecycle: McpLifecycle | undefined;

  beforeEach(async () => {
    origHome = process.env.HOME;
    tmpHome = await mkdtemp(join(tmpdir(), 'mcp-e2e-'));
    logsDir = join(tmpHome, '.myceliate', 'logs');
    process.env.HOME = tmpHome;
    lifecycle = undefined; // reset between tests
  });

  afterEach(async () => {
    if (lifecycle) {
      await lifecycle.teardownAll().catch(() => {
        /* best effort */
      });
    }
    process.env.HOME = origHome;
    await rm(tmpHome, { recursive: true, force: true });
  });

  it('tool_call from recording adapter reaches fake-server and history has tool_result', async () => {
    // Step 1: Install the fake MCP server as a spore.
    await runMcpInstall({
      name: 'fake-spore',
      command: 'node',
      args: [FAKE_SERVER],
      env: {},
      regenerate: false,
      logger: noopLogger,
    });

    const sporeDir = join(tmpHome, '.myceliate', 'skills', 'fake-spore');
    expect(existsSync(join(sporeDir, 'myceliate.yaml'))).toBe(true);
    expect(existsSync(join(sporeDir, 'SKILL.md'))).toBe(true);
    expect(existsSync(join(sporeDir, 'commands', 'echo.md'))).toBe(true);

    // Step 2: Set up McpLifecycle, ToolRegistry, HitlGate.
    lifecycle = new McpLifecycle({ logsDir, logger: noopLogger });
    const toolRegistry = new ToolRegistry();
    const hitlGate = new HitlGate({
      requestApproval: async () => ({ decision: 'approve' as const }),
    });

    // Step 3: Build spore and germinate it (this spawns the real MCP child process
    // and registers fake-spore_echo, fake-spore_add, fake-spore_greet wrappers).
    const spore = buildFakeSpore(sporeDir);
    const registry = SporeRegistry.fromList([spore]);
    const engine = new QueryEngine({ systemPrompt: 'sys', workingBudget: 200_000 });
    engine.appendUser('echo back hello');

    const germinateTool = createGerminateSporeTool({
      registry,
      cwd: tmpHome,
      emit: () => {},
      appendSystemPrompt: (section) => engine.appendSystemSection(section),
      mcpLifecycle: lifecycle,
      toolRegistry,
      hitlGate,
    });

    const gerResult = await germinateTool.handler({ name: 'fake-spore' });
    expect(gerResult.ok).toBe(true);

    // Step 4: Build recording DeepSeek adapter.
    // Iter 0 — tool_call to fake-spore_echo.
    // Iter 1 — final content (terminates loop).
    const capturedRequests: ChatRequest[] = [];
    let callCount = 0;

    const recordingClient: DeepSeekClient = {
      id: 'v3' as const,
      async *stream(req): AsyncIterable<StreamEvent> {
        capturedRequests.push(req);
        callCount++;
        if (callCount === 1) {
          // Emit a tool_call targeting the real MCP tool.
          yield {
            type: 'tool_call',
            id: 'tc-echo-1',
            name: 'fake-spore_echo',
            args: { x: 'hello' },
          };
          yield {
            type: 'done',
            usage: { promptTokens: 10, completionTokens: 5, reasoningTokens: 0 },
          };
        } else {
          yield { type: 'content_delta', text: 'Done.' };
          yield {
            type: 'done',
            usage: { promptTokens: 15, completionTokens: 2, reasoningTokens: 0 },
          };
        }
      },
    };

    // Step 5: Run the ReAct loop — the tool_call must reach the real fake-server.
    const events: StreamEvent[] = [];
    for await (const ev of runReactLoop({
      client: recordingClient,
      engine,
      tools: toolRegistry,
      maxIterations: 3,
    })) {
      events.push(ev);
    }

    // ─── Assertions ────────────────────────────────────────────────────────────

    // (a) Recording adapter saw fake-spore_echo in the tool definitions it received.
    const firstRequest = capturedRequests[0];
    expect(firstRequest).toBeDefined();
    const toolNames = firstRequest?.tools.map((t) => t.name) ?? [];
    expect(toolNames).toContain('fake-spore_echo');

    // (b) The tool_call landed on the real MCP server.
    // The fake-server responds with: { tool: <name>, args: <args> }
    const history = engine.snapshot();
    const toolResultMsg = history.find((m) => m.role === 'tool');
    expect(toolResultMsg).toBeDefined();
    if (toolResultMsg && toolResultMsg.role === 'tool') {
      const content = toolResultMsg.result.content;
      expect(content).toBeTruthy();
      // Parse the JSON content from the fake-server.
      const parsed = JSON.parse(content) as { tool: string; args: { x: string } };
      expect(parsed.tool).toBe('echo');
      expect(parsed.args.x).toBe('hello');
    }

    // afterEach handles lifecycle.teardownAll()
  });
});
