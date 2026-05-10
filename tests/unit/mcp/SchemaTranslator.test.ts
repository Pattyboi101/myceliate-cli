// tests/unit/mcp/SchemaTranslator.test.ts
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpToolDescriptor } from '../../../src/mcp/McpClient.js';
import { translateMcpSchema } from '../../../src/mcp/SchemaTranslator.js';
import type { SporeManifest } from '../../../src/spores/SporeManifest.js';
import { noopLogger } from '../../../src/util/noopLogger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURES = join(__dirname, '../../fixtures/mcp');

function loadJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function loadText(path: string): string {
  return readFileSync(path, 'utf8');
}

// ─── Fixture data ──────────────────────────────────────────────────────────────

const singleToolFixtureDir = join(FIXTURES, 'single-tool');
const multiToolFixtureDir = join(FIXTURES, 'multi-tool-sensitive');

// minimal manifest helper
function makeManifest(overrides: Partial<SporeManifest> = {}): SporeManifest {
  return {
    name: 'test-spore',
    description: 'A test spore.',
    version: '0.1.0',
    accent_color: '#000000',
    keywords: [],
    agents: [],
    mcp_server: {
      command: 'node',
      args: [],
      env: {},
      sensitive_tools: [],
    },
    ...overrides,
  };
}

const AUTO_GEN_MARKER =
  '<!-- MYCELIATE: AUTO-GENERATED ABOVE; user notes BELOW are preserved on --regenerate -->';

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('SchemaTranslator.translateMcpSchema', () => {
  describe('single tool — snapshot match', () => {
    it('skillBody matches expected-skill.md golden fixture', () => {
      const tools = loadJson<McpToolDescriptor[]>(join(singleToolFixtureDir, 'tools.json'));
      const manifest = makeManifest({
        name: 'fetcher',
        description: 'A spore that fetches web content via an MCP server.',
        mcp_server: {
          command: 'npx',
          args: ['fake'],
          env: {},
          sensitive_tools: [],
        },
      });
      const expected = loadText(join(singleToolFixtureDir, 'expected-skill.md'));
      const result = translateMcpSchema(tools, manifest, noopLogger);
      expect(result.skillBody).toBe(expected);
    });

    it('commands/fetch.md matches expected-commands/fetch.md golden fixture', () => {
      const tools = loadJson<McpToolDescriptor[]>(join(singleToolFixtureDir, 'tools.json'));
      const manifest = makeManifest({
        name: 'fetcher',
        description: 'A spore that fetches web content via an MCP server.',
        mcp_server: {
          command: 'npx',
          args: ['fake'],
          env: {},
          sensitive_tools: [],
        },
      });
      const expected = loadText(join(singleToolFixtureDir, 'expected-commands', 'fetch.md'));
      const result = translateMcpSchema(tools, manifest, noopLogger);
      expect(result.commandFiles.get('fetch.md')).toBe(expected);
    });
  });

  describe('multiple tools with sensitive tool declared', () => {
    it('skillBody matches expected-skill.md golden fixture', () => {
      const tools = loadJson<McpToolDescriptor[]>(join(multiToolFixtureDir, 'tools.json'));
      const manifest = makeManifest({
        name: 'docstore',
        description: 'A spore for searching and managing documents via an MCP server.',
        version: '0.2.0',
        accent_color: '#1a2b3c',
        mcp_server: {
          command: 'node',
          args: ['server.js'],
          env: {},
          sensitive_tools: ['delete-document'],
        },
      });
      const expected = loadText(join(multiToolFixtureDir, 'expected-skill.md'));
      const result = translateMcpSchema(tools, manifest, noopLogger);
      expect(result.skillBody).toBe(expected);
    });

    it('sensitive tool command file includes "Sensitive:" notice', () => {
      const tools = loadJson<McpToolDescriptor[]>(join(multiToolFixtureDir, 'tools.json'));
      const manifest = makeManifest({
        name: 'docstore',
        description: 'A spore for searching and managing documents via an MCP server.',
        version: '0.2.0',
        accent_color: '#1a2b3c',
        mcp_server: {
          command: 'node',
          args: ['server.js'],
          env: {},
          sensitive_tools: ['delete-document'],
        },
      });
      const expected = loadText(
        join(multiToolFixtureDir, 'expected-commands', 'delete-document.md'),
      );
      const result = translateMcpSchema(tools, manifest, noopLogger);
      const deleteDocContent = result.commandFiles.get('delete-document.md');
      expect(deleteDocContent).toBe(expected);
      expect(deleteDocContent).toContain('**Sensitive:**');
    });

    it('non-sensitive command files do not include "Sensitive:" notice', () => {
      const tools = loadJson<McpToolDescriptor[]>(join(multiToolFixtureDir, 'tools.json'));
      const manifest = makeManifest({
        name: 'docstore',
        description: 'A spore for searching and managing documents via an MCP server.',
        version: '0.2.0',
        accent_color: '#1a2b3c',
        mcp_server: {
          command: 'node',
          args: ['server.js'],
          env: {},
          sensitive_tools: ['delete-document'],
        },
      });
      const result = translateMcpSchema(tools, manifest, noopLogger);
      const searchContent = result.commandFiles.get('search.md');
      expect(searchContent).not.toContain('**Sensitive:**');
    });

    it('all three command files match expected golden fixtures', () => {
      const tools = loadJson<McpToolDescriptor[]>(join(multiToolFixtureDir, 'tools.json'));
      const manifest = makeManifest({
        name: 'docstore',
        description: 'A spore for searching and managing documents via an MCP server.',
        version: '0.2.0',
        accent_color: '#1a2b3c',
        mcp_server: {
          command: 'node',
          args: ['server.js'],
          env: {},
          sensitive_tools: ['delete-document'],
        },
      });
      const result = translateMcpSchema(tools, manifest, noopLogger);
      for (const file of ['search.md', 'delete-document.md', 'ping.md']) {
        const expected = loadText(join(multiToolFixtureDir, 'expected-commands', file));
        expect(result.commandFiles.get(file), `${file} mismatch`).toBe(expected);
      }
    });
  });

  describe('tool with no args', () => {
    it('renders "No arguments required." prose instead of an Arguments: section when properties is empty', () => {
      const tools: McpToolDescriptor[] = [
        {
          name: 'ping',
          description: 'Check server availability.',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
            additionalProperties: false,
          },
        },
      ];
      const manifest = makeManifest({ name: 'myspore' });
      const result = translateMcpSchema(tools, manifest, noopLogger);
      const pingContent = result.commandFiles.get('ping.md');
      expect(pingContent).toBeDefined();
      // No arguments section header should appear — tool has none
      expect(pingContent).not.toContain('**Arguments:**');
      // Should render with no-args prose instead
      expect(pingContent).toContain('No arguments required.');
    });
  });

  describe('tool with nested object args', () => {
    it('renders nested properties as indented bullet hierarchy', () => {
      const tools: McpToolDescriptor[] = [
        {
          name: 'create-item',
          description: 'Create a new item.',
          inputSchema: {
            type: 'object',
            properties: {
              payload: {
                type: 'object',
                description: 'Item payload',
                properties: {
                  title: { type: 'string', description: 'Item title' },
                  count: { type: 'number', description: 'Item count' },
                },
              },
            },
            required: ['payload'],
            additionalProperties: false,
          },
        },
      ];
      const manifest = makeManifest({ name: 'itemstore' });
      const result = translateMcpSchema(tools, manifest, noopLogger);
      const skillBody = result.skillBody;
      // The capability line should show the top-level arg
      expect(skillBody).toContain('itemstore_create-item(payload: object)');
      // The hierarchy should show nested properties indented at depth-2 (4 spaces = 2 levels × 2 spaces)
      expect(skillBody).toContain('    - `title`');
      expect(skillBody).toContain('    - `count`');
    });
  });

  describe('empty tools list', () => {
    it('emits a "no capabilities discovered" SKILL.md body with auto-gen marker', () => {
      const manifest = makeManifest({ name: 'empty-spore' });
      const warnSpy = vi.fn();
      const logger = { ...noopLogger, warn: warnSpy };
      const result = translateMcpSchema([], manifest, logger);
      expect(result.skillBody.toLowerCase()).toContain('no capabilities discovered');
      expect(result.skillBody).toContain(AUTO_GEN_MARKER);
      expect(result.commandFiles.size).toBe(0);
    });

    it('calls logger.warn for the empty-tools edge case', () => {
      const manifest = makeManifest({ name: 'empty-spore' });
      const warnSpy = vi.fn();
      const logger = { ...noopLogger, warn: warnSpy };
      translateMcpSchema([], manifest, logger);
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ msg: expect.stringContaining('no tools') }),
      );
    });
  });

  describe('auto-gen marker', () => {
    it('every generated SKILL.md body ends with the auto-gen marker', () => {
      const tools: McpToolDescriptor[] = [
        {
          name: 'noop',
          description: 'Does nothing.',
          inputSchema: { type: 'object', properties: {}, required: [] },
        },
      ];
      const manifest = makeManifest({ name: 'my-spore' });
      const result = translateMcpSchema(tools, manifest, noopLogger);
      expect(result.skillBody.trimEnd().endsWith(AUTO_GEN_MARKER)).toBe(true);
    });
  });

  describe('naming conventions', () => {
    it('commandFiles map keys use raw tool name (e.g. "fetch.md" not "fetcher_fetch.md")', () => {
      const tools: McpToolDescriptor[] = [
        {
          name: 'fetch',
          description: 'Fetch a URL.',
          inputSchema: { type: 'object', properties: {}, required: [] },
        },
      ];
      const manifest = makeManifest({ name: 'fetcher' });
      const result = translateMcpSchema(tools, manifest, noopLogger);
      expect(result.commandFiles.has('fetch.md')).toBe(true);
      expect(result.commandFiles.has('fetcher_fetch.md')).toBe(false);
    });

    it('command file frontmatter name: matches raw tool name', () => {
      const tools: McpToolDescriptor[] = [
        {
          name: 'fetch',
          description: 'Fetch a URL.',
          inputSchema: { type: 'object', properties: {}, required: [] },
        },
      ];
      const manifest = makeManifest({ name: 'fetcher' });
      const result = translateMcpSchema(tools, manifest, noopLogger);
      const content = result.commandFiles.get('fetch.md') ?? '';
      expect(content).toContain('name: fetch');
    });

    it('SKILL.md body uses namespaced form for capability references', () => {
      const tools: McpToolDescriptor[] = [
        {
          name: 'fetch',
          description: 'Fetch a URL.',
          inputSchema: { type: 'object', properties: {}, required: [] },
        },
      ];
      const manifest = makeManifest({ name: 'fetcher' });
      const result = translateMcpSchema(tools, manifest, noopLogger);
      expect(result.skillBody).toContain('fetcher_fetch');
    });

    it('description truncated to 200 chars in command file frontmatter', () => {
      const longDesc = 'A'.repeat(250);
      const tools: McpToolDescriptor[] = [
        {
          name: 'verbose-tool',
          description: longDesc,
          inputSchema: { type: 'object', properties: {}, required: [] },
        },
      ];
      const manifest = makeManifest({ name: 'my-spore' });
      const result = translateMcpSchema(tools, manifest, noopLogger);
      const content = result.commandFiles.get('verbose-tool.md') ?? '';
      // Extract frontmatter description
      const fmMatch = /^---\n([\s\S]*?)\n---/.exec(content);
      expect(fmMatch).not.toBeNull();
      if (!fmMatch) return; // type-narrowing for strict checks
      const fmLines = (fmMatch[1] ?? '').split('\n');
      const descLine = fmLines.find((l) => l.startsWith('description:')) ?? '';
      const descValue = descLine.replace(/^description:\s*/, '');
      expect(descValue.length).toBeLessThanOrEqual(200);
    });
  });
});
