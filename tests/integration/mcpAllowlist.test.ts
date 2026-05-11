// tests/integration/mcpAllowlist.test.ts
//
// allowed_tools × dynamic registration ordering (subagent M4).
//
// Spec §5.9: verifies that when a MCP-spore is germinated with
// allowed_tools containing namespaced tool names (e.g. fake-spore_navigate),
// the dynamically-registered MCP wrappers are visible through the allowlist
// filter without triggering an allowlist_unknown_tool warning.
//
// Also covers the regression: a hand-authored spore with
// allowed_tools: ['bash'] still works (existing single-active allowlist
// semantics unchanged).
//
// Does NOT require Redis. Uses RecordingMcpClient (no real child process).

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootTools } from '../../src/runtime/bootTools.js';
import type { McpLifecycle } from '../../src/runtime/mcpLifecycle.js';
import type { ApprovalRequest } from '../../src/security/hitlGate.js';
import { HitlGate } from '../../src/security/hitlGate.js';
import type { Spore } from '../../src/spores/Spore.js';
import { SporeRegistry } from '../../src/spores/SporeRegistry.js';
import { createGerminateSporeTool } from '../../src/tools/germinate_spore.js';
import type { Logger } from '../../src/util/logger.js';
import { RecordingMcpClient } from './RecordingMcpClient.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function noopLikeLogger(warnCalls: Array<Record<string, unknown>>): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: (entry) => warnCalls.push(entry as Record<string, unknown>),
    error: () => {},
    flush: async () => {},
  };
}

function fakeHitl(): HitlGate {
  return new HitlGate({
    requestApproval: vi
      .fn<[ApprovalRequest], Promise<{ decision: 'approve' | 'reject' }>>()
      .mockResolvedValue({
        decision: 'approve',
      }),
  });
}

/**
 * Build a minimal Spore for an MCP-spore that declares allowed_tools using
 * the namespaced form, and a mcp_server block (so germinate_spore spawns).
 */
function buildMcpSpore(name: string, allowedTools: string[], mcpCommand = '/usr/bin/node'): Spore {
  return {
    name,
    tier: 'user',
    dir: `/fake/${name}`,
    manifest: {
      name,
      description: `${name} sector pack.`,
      version: '1.0.0',
      accent_color: '#c5a45f',
      keywords: [],
      agents: [],
      allowed_tools: allowedTools,
      mcp_server: {
        command: mcpCommand,
        args: [],
        env: {},
        sensitive_tools: [],
      },
    },
    sectorFrontmatter: { name, description: `${name} sector.` },
    sectorSkillPath: `/fake/${name}/SKILL.md`,
    personas: [],
    commands: [],
  };
}

/**
 * Build a minimal Spore for a hand-authored (non-MCP) spore with
 * an explicit allowed_tools list (e.g. ['bash']).
 */
function buildPlainSpore(name: string, allowedTools: string[]): Spore {
  return {
    name,
    tier: 'bundled',
    dir: `/fake/${name}`,
    manifest: {
      name,
      description: `${name} sector pack.`,
      version: '1.0.0',
      accent_color: '#abcdef',
      keywords: [],
      agents: [],
      allowed_tools: allowedTools,
    },
    sectorFrontmatter: { name, description: `${name} sector.` },
    sectorSkillPath: `/fake/${name}/SKILL.md`,
    personas: [],
    commands: [],
  };
}

/**
 * Build a minimal stub McpLifecycle whose spawn() returns a given client.
 */
function buildStubLifecycle(client: RecordingMcpClient): McpLifecycle {
  return {
    spawn: vi.fn().mockResolvedValue(client),
    teardown: vi.fn().mockResolvedValue(undefined),
    teardownAll: vi.fn().mockResolvedValue(undefined),
    getActive: vi.fn().mockReturnValue(client),
    listActive: vi.fn().mockReturnValue([]),
    setOnUnexpectedExit: vi.fn(),
  } as unknown as McpLifecycle;
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'mcp-allowlist-'));
  // Write stub SKILL.md files so germinate_spore can read them.
  await mkdir(join(workspace, 'fake-nav'), { recursive: true });
  await writeFile(
    join(workspace, 'fake-nav', 'SKILL.md'),
    '---\nname: fake-nav\ndescription: Fake nav sector.\n---\nNavigate body.\n',
    'utf8',
  );
  await mkdir(join(workspace, 'bash-only'), { recursive: true });
  await writeFile(
    join(workspace, 'bash-only', 'SKILL.md'),
    '---\nname: bash-only\ndescription: Bash only sector.\n---\nBash body.\n',
    'utf8',
  );
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('allowed_tools × dynamic MCP registration ordering', () => {
  it('MCP wrapper registered after setActiveSpore — no allowlist_unknown_tool warning fires', async () => {
    const warnCalls: Array<Record<string, unknown>> = [];
    const logger = noopLikeLogger(warnCalls);

    // RecordingMcpClient predeclares a single tool: 'navigate'.
    // After germination, toolRegistry will have 'fake-nav_navigate' registered.
    const recordingClient = new RecordingMcpClient({
      predeclaredTools: [
        {
          name: 'navigate',
          description: 'Navigate to a URL',
          inputSchema: {
            type: 'object',
            properties: { url: { type: 'string' } },
            required: ['url'],
          },
        },
      ],
    });
    const lifecycle = buildStubLifecycle(recordingClient);

    // Spore declares allowed_tools with the NAMESPACED name.
    const navSpore: Spore = {
      ...buildMcpSpore('fake-nav', ['fake-nav_navigate']),
      sectorSkillPath: join(workspace, 'fake-nav', 'SKILL.md'),
    };

    const registry = SporeRegistry.fromList([navSpore]);
    const hitl = fakeHitl();
    const cwd = workspace;

    const { tools, setActiveSpore } = bootTools({
      hitl,
      registry,
      logger,
      cwd,
      mcpLifecycle: lifecycle,
      emit: () => {},
      appendSystemPrompt: () => {},
    });

    // Step 1: germinate the spore — this registers fake-nav_navigate wrapper.
    const germinateTool = createGerminateSporeTool({
      registry,
      cwd,
      emit: () => {},
      appendSystemPrompt: () => {},
      mcpLifecycle: lifecycle,
      toolRegistry: tools,
      hitlGate: hitl,
    });
    const result = await germinateTool.handler({ name: 'fake-nav' });
    expect(result.ok).toBe(true);

    // Verify the wrapper was registered.
    const execToolNames = tools.byCapability('execution').map((t) => t.name);
    expect(execToolNames).toContain('fake-nav_navigate');

    // Step 2: activate the spore's allowlist AFTER germination (realistic ordering:
    // the user calls setActiveSpore once the spore is in the registry, which happens
    // after germination registers the MCP wrappers).
    setActiveSpore('fake-nav');

    // Step 3: assert no allowlist_unknown_tool warning was fired.
    const unknownWarnings = warnCalls.filter((e) => e.event === 'allowlist_unknown_tool');
    expect(unknownWarnings).toHaveLength(0);

    // Step 4: assert the wrapper IS visible through the active allowlist.
    const activeNames = tools.getActiveTools().map((t) => t.name);
    expect(activeNames).toContain('fake-nav_navigate');
    // Coordination tools always visible (regardless of allowlist).
    expect(activeNames).toContain('germinate_spore');
    expect(activeNames).toContain('spawn_subagent');
  });

  it('setActiveSpore before germination — allowlist_unknown_tool fires, wrapper absent', async () => {
    const warnCalls: Array<Record<string, unknown>> = [];
    const logger = noopLikeLogger(warnCalls);

    // Spore declares allowed_tools with the NAMESPACED name.
    const navSpore: Spore = {
      ...buildMcpSpore('fake-nav', ['fake-nav_navigate']),
      sectorSkillPath: join(workspace, 'fake-nav', 'SKILL.md'),
    };

    const registry = SporeRegistry.fromList([navSpore]);
    const hitl = fakeHitl();

    const { tools, setActiveSpore } = bootTools({
      hitl,
      registry,
      logger,
      cwd: workspace,
    });

    // Activate allowlist BEFORE any germination (no MCP wrappers registered yet).
    setActiveSpore('fake-nav');

    // The namespaced tool is unknown at this point → warning fires.
    const unknownWarnings = warnCalls.filter((e) => e.event === 'allowlist_unknown_tool');
    expect(unknownWarnings.length).toBeGreaterThan(0);
    expect(unknownWarnings.some((e) => e.tool === 'fake-nav_navigate')).toBe(true);

    // The tool is not visible through the active allowlist.
    const activeNames = tools.getActiveTools().map((t) => t.name);
    expect(activeNames).not.toContain('fake-nav_navigate');
  });

  it('regression: hand-authored spore with allowed_tools: [bash] works unchanged', async () => {
    const warnCalls: Array<Record<string, unknown>> = [];
    const logger = noopLikeLogger(warnCalls);

    // Plain (non-MCP) spore that only allows 'bash'.
    const bashSpore: Spore = {
      ...buildPlainSpore('bash-only', ['bash']),
      sectorSkillPath: join(workspace, 'bash-only', 'SKILL.md'),
    };

    const registry = SporeRegistry.fromList([bashSpore]);
    const hitl = fakeHitl();

    const { tools, setActiveSpore } = bootTools({
      hitl,
      registry,
      logger,
      cwd: workspace,
    });

    // Activate the bash-only spore allowlist.
    setActiveSpore('bash-only');

    // No unexpected warnings (bash is a known tool).
    const unknownWarnings = warnCalls.filter((e) => e.event === 'allowlist_unknown_tool');
    expect(unknownWarnings).toHaveLength(0);

    // Only bash + coordination tools should be visible.
    const activeNames = tools.getActiveTools().map((t) => t.name);
    expect(activeNames).toContain('bash');
    expect(activeNames).toContain('germinate_spore');
    expect(activeNames).toContain('spawn_subagent');
    // Other execution tools should be hidden.
    expect(activeNames).not.toContain('read_file');
    expect(activeNames).not.toContain('write_file');
    expect(activeNames).not.toContain('grep');
    expect(activeNames).not.toContain('list_dir');
  });

  it('RecordingMcpClient.callTool records the call and returns cannedResult', async () => {
    const client = new RecordingMcpClient({
      predeclaredTools: [
        {
          name: 'navigate',
          description: 'Navigate to a URL',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
      cannedResult: {
        content: [{ type: 'text', text: 'navigation complete' }],
        isError: false,
      },
    });

    await client.initialize();
    const tools = await client.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe('navigate');

    const result = await client.callTool('navigate', { url: 'https://example.com' });
    expect(result.content[0]).toMatchObject({ type: 'text', text: 'navigation complete' });
    expect(result.isError).toBe(false);

    const calls = client.getCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe('navigate');
    expect(calls[0]?.args).toEqual({ url: 'https://example.com' });

    // Interface checks.
    expect(client.isFaulted()).toBe(false);
    expect(client.getChildPid()).toBeNull();
    await client.close(); // No-op — should not throw.
  });
});
