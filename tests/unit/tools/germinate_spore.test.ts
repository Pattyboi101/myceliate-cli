// tests/unit/tools/germinate_spore.test.ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpClient, McpToolDescriptor, McpToolResult } from '../../../src/mcp/McpClient.js';
import { McpServerCrashedError, McpToolTimeoutError } from '../../../src/mcp/McpClient.js';
import type { McpLifecycle } from '../../../src/runtime/mcpLifecycle.js';
import type { ApprovalRequest } from '../../../src/security/hitlGate.js';
import { HitlGate } from '../../../src/security/hitlGate.js';
import type { Spore } from '../../../src/spores/Spore.js';
import { SporeRegistry } from '../../../src/spores/SporeRegistry.js';
import { readPin } from '../../../src/spores/pinFile.js';
import { createGerminateSporeTool } from '../../../src/tools/germinate_spore.js';
import { ToolRegistry } from '../../../src/tools/registry.js';
import type { Logger } from '../../../src/util/logger.js';

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  flush: async () => {},
};

async function buildFixtureSpore(root: string, name: string, accent: string): Promise<void> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} sector.\n---\n${name} body.\n`,
    'utf8',
  );
  await writeFile(
    join(dir, 'myceliate.yaml'),
    `name: ${name}\ndescription: ${name} sector pack.\nversion: 1.0.0\naccent_color: "${accent}"\nagents: []\n`,
    'utf8',
  );
}

async function buildMcpFixtureSpore(
  root: string,
  name: string,
  accent: string,
  sensitiveTools: string[] = [],
): Promise<void> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} sector.\n---\n${name} body referencing ${name}_navigate.\n`,
    'utf8',
  );
  const sensitiveToolsYaml =
    sensitiveTools.length > 0
      ? `\n  sensitive_tools: [${sensitiveTools.map((t) => `"${t}"`).join(', ')}]`
      : '';
  await writeFile(
    join(dir, 'myceliate.yaml'),
    `name: ${name}\ndescription: ${name} sector pack.\nversion: 1.0.0\naccent_color: "${accent}"\nagents: []\nmcp_server:\n  command: /usr/bin/node\n  args: []\n  env: {}${sensitiveToolsYaml}\n`,
    'utf8',
  );
}

/** Build a stub McpClient that returns a fixed set of tool descriptors. */
function buildStubMcpClient(tools: McpToolDescriptor[]): McpClient {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue(tools),
    callTool: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
    } satisfies McpToolResult),
    close: vi.fn().mockResolvedValue(undefined),
    isFaulted: vi.fn().mockReturnValue(false),
    onUnexpectedExit: vi.fn(),
    getChildPid: vi.fn().mockReturnValue(null),
  };
}

/** Build a stub McpLifecycle that returns a fixed client from spawn(). */
function buildStubLifecycle(client: McpClient): McpLifecycle {
  return {
    spawn: vi.fn().mockResolvedValue(client),
    teardown: vi.fn().mockResolvedValue(undefined),
    teardownAll: vi.fn().mockResolvedValue(undefined),
    getActive: vi.fn().mockReturnValue(client),
    listActive: vi.fn().mockReturnValue([]),
    setOnUnexpectedExit: vi.fn(),
  } as unknown as McpLifecycle;
}

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'germinate-'));
});
afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe('germinate_spore tool', () => {
  it('germinates a known spore: writes pin, emits event, appends body to system prompt', async () => {
    const bundledDir = join(workspace, 'bundled');
    const cwd = join(workspace, 'project-cwd');
    await mkdir(bundledDir, { recursive: true });
    await mkdir(cwd, { recursive: true });
    await buildFixtureSpore(bundledDir, 'demo', '#abcdef');

    const registry = await SporeRegistry.discover(
      { bundledDir, userDir: '/none', projectDir: '/none' },
      { logger: noopLogger },
    );
    const events: Array<unknown> = [];
    let appendedBody: string | null = null;
    const tool = createGerminateSporeTool({
      registry,
      cwd,
      emit: (e) => events.push(e),
      appendSystemPrompt: (s) => {
        appendedBody = s;
      },
    });

    const result = await tool.handler({ name: 'demo' });
    expect(result.ok).toBe(true);
    expect(appendedBody).toMatch(/demo body/);
    expect(await readPin(cwd, noopLogger)).toBe('demo');
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'germination', spore: 'demo', accent_color: '#abcdef' }),
    );
  });

  it('rejects unknown spore name', async () => {
    const registry = await SporeRegistry.discover(
      { bundledDir: '/none', userDir: '/none', projectDir: '/none' },
      { logger: noopLogger },
    );
    const tool = createGerminateSporeTool({
      registry,
      cwd: workspace,
      emit: () => {},
      appendSystemPrompt: () => {},
    });
    const result = await tool.handler({ name: 'nonexistent' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unknown spore/);
  });

  // ─── MCP spore tests ──────────────────────────────────────────────────────────

  it('MCP spore: calls lifecycle.spawn, registers namespaced wrappers, injects body', async () => {
    const bundledDir = join(workspace, 'bundled');
    const cwd = join(workspace, 'project-cwd');
    await mkdir(bundledDir, { recursive: true });
    await mkdir(cwd, { recursive: true });
    await buildMcpFixtureSpore(bundledDir, 'playwright', '#ff0000');

    const registry = await SporeRegistry.discover(
      { bundledDir, userDir: '/none', projectDir: '/none' },
      { logger: noopLogger },
    );

    const stubTools: McpToolDescriptor[] = [
      {
        name: 'navigate',
        description: 'Navigate to a URL',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'screenshot',
        description: 'Take a screenshot',
        inputSchema: { type: 'object', properties: {} },
      },
    ];
    const client = buildStubMcpClient(stubTools);
    const lifecycle = buildStubLifecycle(client);
    const toolRegistry = new ToolRegistry();
    // Register a dummy execution tool so registry isn't empty
    toolRegistry.register({
      name: 'bash',
      description: 'bash stub',
      capability: 'execution',
      inputSchema: { kind: 'json-schema', jsonSchema: { type: 'object' } },
      run: async () => 'stub',
    });

    const hitlGate = new HitlGate({
      requestApproval: vi.fn().mockResolvedValue({ decision: 'approve' }),
    });
    const appendedBodies: string[] = [];
    const events: Array<unknown> = [];

    const tool = createGerminateSporeTool({
      registry,
      cwd,
      emit: (e) => events.push(e),
      appendSystemPrompt: (s) => appendedBodies.push(s),
      mcpLifecycle: lifecycle,
      toolRegistry,
      hitlGate,
    });

    const result = await tool.handler({ name: 'playwright' });

    expect(result.ok).toBe(true);
    // lifecycle.spawn was called with the playwright spore
    expect(lifecycle.spawn).toHaveBeenCalledOnce();

    // Namespaced wrappers registered
    const activeTools = toolRegistry.getActiveTools();
    const toolNames = activeTools.map((t) => t.name);
    expect(toolNames).toContain('playwright_navigate');
    expect(toolNames).toContain('playwright_screenshot');

    // Wrappers use json-schema kind (R9 MCP tools are execution)
    const navigateTool = activeTools.find((t) => t.name === 'playwright_navigate');
    expect(navigateTool?.capability).toBe('execution');
    expect(navigateTool?.inputSchema.kind).toBe('json-schema');

    // Body injected (tools BEFORE body — navigate wrapper exists before body inject)
    expect(appendedBodies.length).toBeGreaterThan(0);
    expect(appendedBodies[0]).toMatch(/playwright body/);

    // Germination event emitted
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'germination', spore: 'playwright' }),
    );
  });

  it('non-MCP spore does NOT call lifecycle.spawn', async () => {
    const bundledDir = join(workspace, 'bundled');
    const cwd = join(workspace, 'project-cwd');
    await mkdir(bundledDir, { recursive: true });
    await mkdir(cwd, { recursive: true });
    await buildFixtureSpore(bundledDir, 'demo', '#abcdef');

    const registry = await SporeRegistry.discover(
      { bundledDir, userDir: '/none', projectDir: '/none' },
      { logger: noopLogger },
    );

    const client = buildStubMcpClient([]);
    const lifecycle = buildStubLifecycle(client);
    const toolRegistry = new ToolRegistry();
    const hitlGate = new HitlGate({ requestApproval: vi.fn() });

    const tool = createGerminateSporeTool({
      registry,
      cwd,
      emit: () => {},
      appendSystemPrompt: () => {},
      mcpLifecycle: lifecycle,
      toolRegistry,
      hitlGate,
    });

    const result = await tool.handler({ name: 'demo' });

    expect(result.ok).toBe(true);
    expect(lifecycle.spawn).not.toHaveBeenCalled();
    // No MCP wrappers registered
    expect(toolRegistry.getActiveTools()).toHaveLength(0);
  });

  it('multi-active: germinate playwright then postgres → both spore wrappers in registry', async () => {
    const bundledDir = join(workspace, 'bundled');
    const cwd = join(workspace, 'project-cwd');
    await mkdir(bundledDir, { recursive: true });
    await mkdir(cwd, { recursive: true });
    await buildMcpFixtureSpore(bundledDir, 'playwright', '#ff0000');
    await buildMcpFixtureSpore(bundledDir, 'postgres', '#00ff00');

    const registry = await SporeRegistry.discover(
      { bundledDir, userDir: '/none', projectDir: '/none' },
      { logger: noopLogger },
    );

    const playwrightTools: McpToolDescriptor[] = [
      {
        name: 'navigate',
        description: 'Navigate',
        inputSchema: { type: 'object', properties: {} },
      },
    ];
    const postgresTools: McpToolDescriptor[] = [
      {
        name: 'query',
        description: 'Run a SQL query',
        inputSchema: { type: 'object', properties: {} },
      },
    ];

    const playwrightClient = buildStubMcpClient(playwrightTools);
    const postgresClient = buildStubMcpClient(postgresTools);

    // Lifecycle returns different clients depending on which spore is spawned
    const lifecycle = {
      spawn: vi.fn().mockImplementation(async (spore: Spore) => {
        if (spore.name === 'playwright') return playwrightClient;
        if (spore.name === 'postgres') return postgresClient;
        throw new Error(`Unexpected spore: ${spore.name}`);
      }),
      teardown: vi.fn(),
      teardownAll: vi.fn(),
      getActive: vi.fn(),
      listActive: vi.fn().mockReturnValue([]),
      setOnUnexpectedExit: vi.fn(),
    } as unknown as McpLifecycle;

    const toolRegistry = new ToolRegistry();
    const hitlGate = new HitlGate({
      requestApproval: vi.fn().mockResolvedValue({ decision: 'approve' }),
    });
    const appendedBodies: string[] = [];

    const tool = createGerminateSporeTool({
      registry,
      cwd,
      emit: () => {},
      appendSystemPrompt: (s) => appendedBodies.push(s),
      mcpLifecycle: lifecycle,
      toolRegistry,
      hitlGate,
    });

    await tool.handler({ name: 'playwright' });
    await tool.handler({ name: 'postgres' });

    // Both spores' wrappers are in registry (multi-active — no teardown)
    const toolNames = toolRegistry.getActiveTools().map((t) => t.name);
    expect(toolNames).toContain('playwright_navigate');
    expect(toolNames).toContain('postgres_query');

    // Both clients were spawned
    expect(lifecycle.spawn).toHaveBeenCalledTimes(2);

    // Body injection: postgres body is the latest (single-active-body semantics)
    // Both bodies were appended (appendSystemPrompt uses replaceGerminatedSection externally)
    expect(appendedBodies).toHaveLength(2);
    expect(appendedBodies[1]).toMatch(/postgres body/);
  });

  it('idempotent re-germination: re-germinating same MCP spore skips wrapper re-registration', async () => {
    const bundledDir = join(workspace, 'bundled');
    const cwd = join(workspace, 'project-cwd');
    await mkdir(bundledDir, { recursive: true });
    await mkdir(cwd, { recursive: true });
    await buildMcpFixtureSpore(bundledDir, 'playwright', '#ff0000');

    const registry = await SporeRegistry.discover(
      { bundledDir, userDir: '/none', projectDir: '/none' },
      { logger: noopLogger },
    );

    const stubTools: McpToolDescriptor[] = [
      {
        name: 'navigate',
        description: 'Navigate',
        inputSchema: { type: 'object', properties: {} },
      },
    ];
    const client = buildStubMcpClient(stubTools);
    const lifecycle = buildStubLifecycle(client);
    const toolRegistry = new ToolRegistry();
    const hitlGate = new HitlGate({
      requestApproval: vi.fn().mockResolvedValue({ decision: 'approve' }),
    });

    const tool = createGerminateSporeTool({
      registry,
      cwd,
      emit: () => {},
      appendSystemPrompt: () => {},
      mcpLifecycle: lifecycle,
      toolRegistry,
      hitlGate,
    });

    // First germination — registers wrapper
    await tool.handler({ name: 'playwright' });
    expect(
      toolRegistry.getActiveTools().filter((t) => t.name === 'playwright_navigate'),
    ).toHaveLength(1);

    // Second germination — idempotent: lifecycle.spawn still called (idempotent by McpLifecycle),
    // but wrapper registration is skipped (pre-existence check)
    // We verify by checking that register is NOT called again. Since ToolRegistry.register throws
    // on duplicates, if re-registration were attempted, the second handler call would throw.
    await expect(tool.handler({ name: 'playwright' })).resolves.toMatchObject({ ok: true });

    // Still exactly one wrapper — not duplicated
    expect(
      toolRegistry.getActiveTools().filter((t) => t.name === 'playwright_navigate'),
    ).toHaveLength(1);
  });

  it('idempotent re-germination (Scenario B): skips wrapper re-registration when allowlist is active', async () => {
    // Scenario B: the spore was already germinated and setActiveAllowlist was called with the
    // namespaced tool names (simulating setActiveSporeFromGerminate). A second germinate call must
    // still detect the existing wrappers via byCapability('execution') — which is allowlist-agnostic
    // — and skip re-registration rather than throwing "Tool already registered".
    const bundledDir = join(workspace, 'bundled');
    const cwd = join(workspace, 'project-cwd');
    await mkdir(bundledDir, { recursive: true });
    await mkdir(cwd, { recursive: true });
    await buildMcpFixtureSpore(bundledDir, 'playwright', '#ff0000');

    const registry = await SporeRegistry.discover(
      { bundledDir, userDir: '/none', projectDir: '/none' },
      { logger: noopLogger },
    );

    const stubTools: McpToolDescriptor[] = [
      {
        name: 'navigate',
        description: 'Navigate to a URL',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'screenshot',
        description: 'Take a screenshot',
        inputSchema: { type: 'object', properties: {} },
      },
    ];
    const client = buildStubMcpClient(stubTools);
    const lifecycle = buildStubLifecycle(client);
    const toolRegistry = new ToolRegistry();
    const hitlGate = new HitlGate({
      requestApproval: vi.fn().mockResolvedValue({ decision: 'approve' }),
    });

    const tool = createGerminateSporeTool({
      registry,
      cwd,
      emit: () => {},
      appendSystemPrompt: () => {},
      mcpLifecycle: lifecycle,
      toolRegistry,
      hitlGate,
    });

    // First germination — registers playwright_navigate + playwright_screenshot
    await tool.handler({ name: 'playwright' });
    expect(
      toolRegistry.byCapability('execution').filter((t) => t.name.startsWith('playwright_')),
    ).toHaveLength(2);

    // Simulate setActiveSporeFromGerminate setting the allowlist to the namespaced tool names.
    // With the old getActiveTools() check, re-germination would also detect the wrappers here
    // because the allowlist exactly matches. With byCapability() it's allowlist-agnostic.
    toolRegistry.setActiveAllowlist(['playwright_navigate', 'playwright_screenshot']);

    // Re-germinate the same spore — must be a no-op for wrapper registration.
    // If re-registration were attempted, ToolRegistry.register throws "Tool already registered"
    // and the handler call would reject. resolves.toMatchObject ensures no throw.
    await expect(tool.handler({ name: 'playwright' })).resolves.toMatchObject({ ok: true });

    // spawn was called twice (McpLifecycle handles its own idempotency, not germinate_spore)
    expect(lifecycle.spawn).toHaveBeenCalledTimes(2);

    // Still exactly 2 wrappers — no duplicates
    expect(
      toolRegistry.byCapability('execution').filter((t) => t.name.startsWith('playwright_')),
    ).toHaveLength(2);
  });

  it('failed spawn surfaces a stream-event error; no registry corruption', async () => {
    const bundledDir = join(workspace, 'bundled');
    const cwd = join(workspace, 'project-cwd');
    await mkdir(bundledDir, { recursive: true });
    await mkdir(cwd, { recursive: true });
    await buildMcpFixtureSpore(bundledDir, 'playwright', '#ff0000');

    const registry = await SporeRegistry.discover(
      { bundledDir, userDir: '/none', projectDir: '/none' },
      { logger: noopLogger },
    );

    const lifecycle = {
      spawn: vi.fn().mockRejectedValue(new Error('MCP server failed to start')),
      teardown: vi.fn(),
      teardownAll: vi.fn(),
      getActive: vi.fn(),
      listActive: vi.fn().mockReturnValue([]),
      setOnUnexpectedExit: vi.fn(),
    } as unknown as McpLifecycle;

    const toolRegistry = new ToolRegistry();
    const hitlGate = new HitlGate({ requestApproval: vi.fn() });
    const events: Array<unknown> = [];

    const tool = createGerminateSporeTool({
      registry,
      cwd,
      emit: (e) => events.push(e),
      appendSystemPrompt: () => {},
      mcpLifecycle: lifecycle,
      toolRegistry,
      hitlGate,
    });

    const result = await tool.handler({ name: 'playwright' });

    // Returns failure result, not throws
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/MCP server failed to start/);

    // No wrappers registered (registry not corrupted)
    expect(toolRegistry.getActiveTools()).toHaveLength(0);

    // No germination event emitted
    expect(events.filter((e) => (e as { type: string }).type === 'germination')).toHaveLength(0);
  });

  it('sensitive tool routing: checkMcp called with (server, tool) when wrapper runs', async () => {
    const bundledDir = join(workspace, 'bundled');
    const cwd = join(workspace, 'project-cwd');
    await mkdir(bundledDir, { recursive: true });
    await mkdir(cwd, { recursive: true });
    // navigate is declared sensitive
    await buildMcpFixtureSpore(bundledDir, 'playwright', '#ff0000', ['navigate']);

    const registry = await SporeRegistry.discover(
      { bundledDir, userDir: '/none', projectDir: '/none' },
      { logger: noopLogger },
    );

    const stubTools: McpToolDescriptor[] = [
      {
        name: 'navigate',
        description: 'Navigate',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'screenshot',
        description: 'Screenshot',
        inputSchema: { type: 'object', properties: {} },
      },
    ];
    const client = buildStubMcpClient(stubTools);
    const lifecycle = buildStubLifecycle(client);
    const toolRegistry = new ToolRegistry();

    const approvalRequests: ApprovalRequest[] = [];
    const hitlGate = new HitlGate({
      requestApproval: vi.fn().mockImplementation(async (req: ApprovalRequest) => {
        approvalRequests.push(req);
        return { decision: 'approve' as const };
      }),
    });

    const tool = createGerminateSporeTool({
      registry,
      cwd,
      emit: () => {},
      appendSystemPrompt: () => {},
      mcpLifecycle: lifecycle,
      toolRegistry,
      hitlGate,
    });

    await tool.handler({ name: 'playwright' });

    // Run the sensitive wrapper
    const navigateTool = toolRegistry
      .getActiveTools()
      .find((t) => t.name === 'playwright_navigate');
    expect(navigateTool).toBeDefined();
    await navigateTool?.run(
      { url: 'https://example.com' } as unknown as Parameters<typeof navigateTool.run>[0],
      {
        cwd,
        abort: new AbortController().signal,
        toolUseId: 'test-use-id',
      },
    );

    // checkMcp was invoked with (server, tool) payload
    expect(approvalRequests).toHaveLength(1);
    expect(approvalRequests[0]).toMatchObject({
      kind: 'mcp',
      server: 'playwright',
      tool: 'navigate',
      requestId: 'test-use-id',
    });

    // Run the non-sensitive wrapper — should NOT trigger checkMcp
    const screenshotTool = toolRegistry
      .getActiveTools()
      .find((t) => t.name === 'playwright_screenshot');
    await screenshotTool?.run({} as unknown as Parameters<typeof screenshotTool.run>[0], {
      cwd,
      abort: new AbortController().signal,
      toolUseId: 'test-use-id-2',
    });

    // Still only 1 approval request (screenshot is not sensitive)
    expect(approvalRequests).toHaveLength(1);
  });

  it('wrapper handles McpServerCrashedError — returns JSON { ok: false } not throw', async () => {
    const bundledDir = join(workspace, 'bundled');
    const cwd = join(workspace, 'project-cwd');
    await mkdir(bundledDir, { recursive: true });
    await mkdir(cwd, { recursive: true });
    await buildMcpFixtureSpore(bundledDir, 'playwright', '#ff0000');

    const registry = await SporeRegistry.discover(
      { bundledDir, userDir: '/none', projectDir: '/none' },
      { logger: noopLogger },
    );

    const crashError = new McpServerCrashedError('playwright', { code: 1, signal: null });
    const client: McpClient = {
      ...buildStubMcpClient([
        {
          name: 'navigate',
          description: 'Navigate',
          inputSchema: { type: 'object', properties: {} },
        },
      ]),
      callTool: vi.fn().mockRejectedValue(crashError),
    };
    const lifecycle = buildStubLifecycle(client);
    const toolRegistry = new ToolRegistry();
    const hitlGate = new HitlGate({ requestApproval: vi.fn() });

    const tool = createGerminateSporeTool({
      registry,
      cwd,
      emit: () => {},
      appendSystemPrompt: () => {},
      mcpLifecycle: lifecycle,
      toolRegistry,
      hitlGate,
    });

    await tool.handler({ name: 'playwright' });

    const navigateTool = toolRegistry
      .getActiveTools()
      .find((t) => t.name === 'playwright_navigate');
    const resultStr = await navigateTool?.run(
      {} as unknown as Parameters<typeof navigateTool.run>[0],
      {
        cwd,
        abort: new AbortController().signal,
        toolUseId: 'test-id',
      },
    );

    expect(resultStr).toBeDefined();
    const parsed = JSON.parse(resultStr ?? '{}');
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/playwright/);
  });

  it('wrapper handles McpToolTimeoutError — returns JSON { ok: false } not throw', async () => {
    const bundledDir = join(workspace, 'bundled');
    const cwd = join(workspace, 'project-cwd');
    await mkdir(bundledDir, { recursive: true });
    await mkdir(cwd, { recursive: true });
    await buildMcpFixtureSpore(bundledDir, 'playwright', '#ff0000');

    const registry = await SporeRegistry.discover(
      { bundledDir, userDir: '/none', projectDir: '/none' },
      { logger: noopLogger },
    );

    const timeoutError = new McpToolTimeoutError('playwright', 'navigate', 30000);
    const client: McpClient = {
      ...buildStubMcpClient([
        {
          name: 'navigate',
          description: 'Navigate',
          inputSchema: { type: 'object', properties: {} },
        },
      ]),
      callTool: vi.fn().mockRejectedValue(timeoutError),
    };
    const lifecycle = buildStubLifecycle(client);
    const toolRegistry = new ToolRegistry();
    const hitlGate = new HitlGate({ requestApproval: vi.fn() });

    const tool = createGerminateSporeTool({
      registry,
      cwd,
      emit: () => {},
      appendSystemPrompt: () => {},
      mcpLifecycle: lifecycle,
      toolRegistry,
      hitlGate,
    });

    await tool.handler({ name: 'playwright' });

    const navigateTool = toolRegistry
      .getActiveTools()
      .find((t) => t.name === 'playwright_navigate');
    const resultStr = await navigateTool?.run(
      {} as unknown as Parameters<typeof navigateTool.run>[0],
      {
        cwd,
        abort: new AbortController().signal,
        toolUseId: 'test-id',
      },
    );

    expect(resultStr).toBeDefined();
    const parsed = JSON.parse(resultStr ?? '{}');
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/navigate/);
  });
});
