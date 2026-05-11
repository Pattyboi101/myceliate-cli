// tests/unit/cli/parseSubcommand.test.ts
//
// Locks the behaviour of parseSubcommand — the unified argv parser introduced in
// Phase 3 (Exoenzyme) that subsumes the old parseResumeFlag / parseNoSporeFlag
// standalone exports and also handles the new `mcp install` subcommand.
//
// Each describe block targets a specific Subcommand kind.

import { describe, expect, it } from 'vitest';
import { parseSubcommand } from '../../../src/cli/parseSubcommand.js';

// ─── interactive branch ────────────────────────────────────────────────────────

describe('parseSubcommand — interactive branch', () => {
  it('empty argv → kind:interactive, noSpore:false, no resumeId', () => {
    const result = parseSubcommand([]);
    expect(result).toEqual({ kind: 'interactive', noSpore: false });
    expect((result as { resumeId?: string }).resumeId).toBeUndefined();
  });

  it('--resume <id> → kind:interactive with resumeId', () => {
    expect(parseSubcommand(['--resume', 'abc'])).toEqual({
      kind: 'interactive',
      resumeId: 'abc',
      noSpore: false,
    });
  });

  it('--resume with extra flags → first wins', () => {
    expect(parseSubcommand(['--first', 'x', '--resume', 'sess-1'])).toEqual({
      kind: 'interactive',
      resumeId: 'sess-1',
      noSpore: false,
    });
  });

  it('--no-spore → kind:interactive, noSpore:true', () => {
    expect(parseSubcommand(['--no-spore'])).toEqual({
      kind: 'interactive',
      noSpore: true,
    });
  });

  it('--resume and --no-spore together', () => {
    expect(parseSubcommand(['--resume', 'id-1', '--no-spore'])).toEqual({
      kind: 'interactive',
      resumeId: 'id-1',
      noSpore: true,
    });
  });

  // Regression: Phase 18 parseResumeFlag throw cases must work via parseSubcommand.
  it('throws when --resume is at end-of-argv', () => {
    expect(() => parseSubcommand(['--resume'])).toThrow(/--resume requires a session-id/);
  });

  it('throws when --resume is followed by another flag', () => {
    expect(() => parseSubcommand(['--resume', '--other-flag'])).toThrow(
      /--resume requires a session-id/,
    );
  });

  it('throws when --resume is followed by an empty string', () => {
    expect(() => parseSubcommand(['--resume', ''])).toThrow(/--resume requires a session-id/);
  });

  it('uses the FIRST occurrence of --resume when it appears multiple times', () => {
    const result = parseSubcommand(['--resume', 'first', '--resume', 'second']);
    expect(result).toMatchObject({ kind: 'interactive', resumeId: 'first' });
  });
});

// ─── mcp-install branch ────────────────────────────────────────────────────────

describe('parseSubcommand — mcp-install branch', () => {
  it('minimal: mcp install <name> --command <cmd> → mcp-install shape', () => {
    expect(parseSubcommand(['mcp', 'install', 'playwright', '--command', 'npx'])).toEqual({
      kind: 'mcp-install',
      name: 'playwright',
      command: 'npx',
      args: [],
      env: {},
      regenerate: false,
    });
  });

  it('--arg flags are collected in order', () => {
    const result = parseSubcommand([
      'mcp',
      'install',
      'playwright',
      '--command',
      'npx',
      '--arg',
      '@playwright/mcp@latest',
    ]);
    expect(result).toEqual({
      kind: 'mcp-install',
      name: 'playwright',
      command: 'npx',
      args: ['@playwright/mcp@latest'],
      env: {},
      regenerate: false,
    });
  });

  it('multiple --arg flags are collected in order', () => {
    const result = parseSubcommand([
      'mcp',
      'install',
      'my-server',
      '--command',
      'node',
      '--arg',
      'server.js',
      '--arg',
      '--port',
      '--arg',
      '3000',
    ]);
    expect(result).toMatchObject({
      kind: 'mcp-install',
      args: ['server.js', '--port', '3000'],
    });
  });

  it('--env KEY=VAL is parsed into env record', () => {
    const result = parseSubcommand([
      'mcp',
      'install',
      'foo',
      '--command',
      'bar',
      '--env',
      'KEY=VAL',
    ]);
    expect(result).toEqual({
      kind: 'mcp-install',
      name: 'foo',
      command: 'bar',
      args: [],
      env: { KEY: 'VAL' },
      regenerate: false,
    });
  });

  it('multiple --env flags are all collected', () => {
    const result = parseSubcommand([
      'mcp',
      'install',
      'foo',
      '--command',
      'bar',
      '--env',
      'A=1',
      '--env',
      'B=2',
    ]);
    expect(result).toMatchObject({
      kind: 'mcp-install',
      env: { A: '1', B: '2' },
    });
  });

  it('--env value with equals in the value part is handled (only split on first =)', () => {
    const result = parseSubcommand([
      'mcp',
      'install',
      'foo',
      '--command',
      'bar',
      '--env',
      'TOKEN=abc=def',
    ]);
    expect(result).toMatchObject({
      kind: 'mcp-install',
      env: { TOKEN: 'abc=def' },
    });
  });

  it('--regenerate flag sets regenerate:true', () => {
    const result = parseSubcommand(['mcp', 'install', 'foo', '--command', 'bar', '--regenerate']);
    expect(result).toMatchObject({ kind: 'mcp-install', regenerate: true });
  });

  it('mcp install without --command throws with a useful message', () => {
    expect(() => parseSubcommand(['mcp', 'install', 'foo'])).toThrow(/--command/);
  });

  it('mcp install without a name throws', () => {
    expect(() => parseSubcommand(['mcp', 'install'])).toThrow();
  });

  it('combined --arg, --env, --regenerate', () => {
    const result = parseSubcommand([
      'mcp',
      'install',
      'playwright',
      '--command',
      'npx',
      '--arg',
      '@playwright/mcp@latest',
      '--env',
      'HEADLESS=1',
      '--regenerate',
    ]);
    expect(result).toEqual({
      kind: 'mcp-install',
      name: 'playwright',
      command: 'npx',
      args: ['@playwright/mcp@latest'],
      env: { HEADLESS: '1' },
      regenerate: true,
    });
  });
});
