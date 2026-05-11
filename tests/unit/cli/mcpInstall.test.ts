// tests/unit/cli/mcpInstall.test.ts
//
// Integration-style unit tests for the atomic mcp install flow.
// Uses the fake MCP server fixture (tests/fixtures/mcp/fake-server.mjs).
// Does NOT require Redis — the install path has no BullMQ dependency.
//
// Each test overrides process.env.HOME to a tmp directory, ensuring tests
// don't pollute the real ~/.myceliate/skills/ directory.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMcpInstall } from '../../../src/cli/mcpInstall.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

const FAKE_SERVER = resolve(
  import.meta.dirname ?? new URL('.', import.meta.url).pathname,
  '../../fixtures/mcp/fake-server.mjs',
);

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), 'mcp-install-test-'));
}

function skillDir(home: string, name: string): string {
  return join(home, '.myceliate', 'skills', name);
}

function stagingRoot(home: string): string {
  return join(home, '.myceliate', 'skills', '.staging');
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe('runMcpInstall — successful install', () => {
  let origHome: string | undefined;
  let home: string;

  beforeEach(() => {
    origHome = process.env.HOME;
    home = tmpHome();
    process.env.HOME = home;
  });

  afterEach(async () => {
    process.env.HOME = origHome;
    await rm(home, { recursive: true, force: true });
  });

  it('writes manifest.yaml, SKILL.md, and commands/*.md into the target dir', async () => {
    await runMcpInstall({
      name: 'fake',
      command: 'node',
      args: [FAKE_SERVER],
      env: {},
      regenerate: false,
    });

    const dir = skillDir(home, 'fake');
    expect(existsSync(join(dir, 'manifest.yaml'))).toBe(true);
    expect(existsSync(join(dir, 'SKILL.md'))).toBe(true);
    // fake server exports 3 tools: echo, add, greet
    expect(existsSync(join(dir, 'commands', 'echo.md'))).toBe(true);
    expect(existsSync(join(dir, 'commands', 'add.md'))).toBe(true);
    expect(existsSync(join(dir, 'commands', 'greet.md'))).toBe(true);
  });

  it('manifest allowed_tools uses namespaced form <name>_<tool>', async () => {
    await runMcpInstall({
      name: 'fake',
      command: 'node',
      args: [FAKE_SERVER],
      env: {},
      regenerate: false,
    });

    const manifestPath = join(skillDir(home, 'fake'), 'manifest.yaml');
    const content = readFileSync(manifestPath, 'utf-8');
    // Should contain namespaced tools
    expect(content).toContain('fake_echo');
    expect(content).toContain('fake_add');
    expect(content).toContain('fake_greet');
    // Should NOT contain un-namespaced raw form as allowed_tools entry
    expect(content).not.toMatch(/allowed_tools:[\s\S]*?- echo\n/);
  });

  it('SKILL.md contains the auto-gen marker', async () => {
    await runMcpInstall({
      name: 'fake',
      command: 'node',
      args: [FAKE_SERVER],
      env: {},
      regenerate: false,
    });

    const skillMd = readFileSync(join(skillDir(home, 'fake'), 'SKILL.md'), 'utf-8');
    expect(skillMd).toContain('MYCELIATE: AUTO-GENERATED ABOVE');
  });

  it('staging dir is cleaned up after successful install', async () => {
    await runMcpInstall({
      name: 'fake',
      command: 'node',
      args: [FAKE_SERVER],
      env: {},
      regenerate: false,
    });

    // After success the staging root may exist but the specific staging subdir is gone
    const staging = stagingRoot(home);
    if (existsSync(staging)) {
      const entries = readdirSafe(staging);
      // No staging entries for 'fake' should remain
      const fakeEntries = entries.filter((e) => e.startsWith('fake-'));
      expect(fakeEntries).toHaveLength(0);
    }
  });
});

describe('runMcpInstall — error cases', () => {
  let origHome: string | undefined;
  let home: string;

  beforeEach(() => {
    origHome = process.env.HOME;
    home = tmpHome();
    process.env.HOME = home;
  });

  afterEach(async () => {
    process.env.HOME = origHome;
    await rm(home, { recursive: true, force: true });
  });

  it('throws if target dir already exists and --regenerate not set', async () => {
    const dir = skillDir(home, 'fake');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'manifest.yaml'), 'name: fake\n');

    await expect(
      runMcpInstall({
        name: 'fake',
        command: 'node',
        args: [FAKE_SERVER],
        env: {},
        regenerate: false,
      }),
    ).rejects.toThrow(/already exists/);
  });

  it('leaves no partial target dir on failure (bad command)', async () => {
    await expect(
      runMcpInstall({
        name: 'my-server',
        command: 'this-command-does-not-exist-at-all',
        args: [],
        env: {},
        regenerate: false,
      }),
    ).rejects.toThrow();

    // Target dir must NOT exist
    expect(existsSync(skillDir(home, 'my-server'))).toBe(false);
    // Staging must also be cleaned up
    const staging = stagingRoot(home);
    if (existsSync(staging)) {
      const entries = readdirSafe(staging);
      const leftover = entries.filter((e) => e.startsWith('my-server-'));
      expect(leftover).toHaveLength(0);
    }
  });
});

describe('runMcpInstall — --regenerate', () => {
  let origHome: string | undefined;
  let home: string;

  beforeEach(() => {
    origHome = process.env.HOME;
    home = tmpHome();
    process.env.HOME = home;
  });

  afterEach(async () => {
    process.env.HOME = origHome;
    await rm(home, { recursive: true, force: true });
  });

  it('regenerate against existing dir succeeds and preserves below-marker content', async () => {
    // First install
    await runMcpInstall({
      name: 'fake',
      command: 'node',
      args: [FAKE_SERVER],
      env: {},
      regenerate: false,
    });

    // Add user content below the marker
    const skillMdPath = join(skillDir(home, 'fake'), 'SKILL.md');
    const original = readFileSync(skillMdPath, 'utf-8');
    const markerIdx = original.indexOf('MYCELIATE: AUTO-GENERATED ABOVE');
    expect(markerIdx).toBeGreaterThan(-1);
    const marker = original.slice(markerIdx, original.indexOf('\n', markerIdx) + 1);
    const withUserContent = `${original}\n## My Notes\n\nUser-added content here.\n`;
    writeFileSync(skillMdPath, withUserContent);

    // Re-install with --regenerate
    await runMcpInstall({
      name: 'fake',
      command: 'node',
      args: [FAKE_SERVER],
      env: {},
      regenerate: true,
    });

    const regenerated = readFileSync(join(skillDir(home, 'fake'), 'SKILL.md'), 'utf-8');
    expect(regenerated).toContain('User-added content here.');
    expect(regenerated).toContain('MYCELIATE: AUTO-GENERATED ABOVE');
  });

  it('regenerate writes fresh manifest.yaml (replaces old one)', async () => {
    // First install
    await runMcpInstall({
      name: 'fake',
      command: 'node',
      args: [FAKE_SERVER],
      env: {},
      regenerate: false,
    });

    // Corrupt the manifest to detect replacement
    const manifestPath = join(skillDir(home, 'fake'), 'manifest.yaml');
    writeFileSync(manifestPath, 'corrupted: true\n');

    await runMcpInstall({
      name: 'fake',
      command: 'node',
      args: [FAKE_SERVER],
      env: {},
      regenerate: true,
    });

    const content = readFileSync(manifestPath, 'utf-8');
    expect(content).not.toContain('corrupted');
    expect(content).toContain('fake');
  });
});

// ─── utility ──────────────────────────────────────────────────────────────────

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
