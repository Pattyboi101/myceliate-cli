// tests/unit/spores/SporeManifest.test.ts
import { describe, expect, it } from 'vitest';
import { parseSporeManifest } from '../../../src/spores/SporeManifest.js';

describe('parseSporeManifest', () => {
  it('parses a valid manifest', () => {
    const yaml = `
name: solo-business
description: Test description for the solo-business spore.
version: 1.0.0
accent_color: "#c5a45f"
keywords:
  - business
  - startup
agents:
  - ceo
  - outreach
`;
    const result = parseSporeManifest(yaml);
    expect(result.name).toBe('solo-business');
    expect(result.accent_color).toBe('#c5a45f');
    expect(result.agents).toEqual(['ceo', 'outreach']);
    expect(result.keywords).toEqual(['business', 'startup']);
  });

  it('rejects manifest with invalid accent_color', () => {
    const yaml = `
name: foo
description: bar
version: 1.0.0
accent_color: not-a-hex
agents: []
`;
    expect(() => parseSporeManifest(yaml)).toThrow(/accent_color/);
  });

  it('rejects manifest with non-kebab name', () => {
    const yaml = `
name: SoloBusiness
description: bar
version: 1.0.0
accent_color: "#000000"
agents: []
`;
    expect(() => parseSporeManifest(yaml)).toThrow(/name/);
  });

  it('defaults keywords + agents to empty arrays when omitted', () => {
    const yaml = `
name: minimal
description: A minimal spore.
version: 1.0.0
accent_color: "#abcdef"
`;
    const result = parseSporeManifest(yaml);
    expect(result.keywords).toEqual([]);
    expect(result.agents).toEqual([]);
  });
});

describe('mcp_server field', () => {
  it('mcp_server absent — manifest validates as before (regression)', () => {
    const yaml = `
name: solo-business
description: A spore without mcp_server.
version: 1.0.0
accent_color: "#c5a45f"
`;
    const result = parseSporeManifest(yaml);
    expect(result.mcp_server).toBeUndefined();
  });

  it('mcp_server present with all fields — validates and applies defaults', () => {
    const yaml = `
name: db-spore
description: A spore with mcp_server.
version: 1.0.0
accent_color: "#1a2b3c"
mcp_server:
  command: /usr/local/bin/mcp-postgres
  args:
    - --port
    - "5432"
  env:
    DB_URL: postgres://localhost/mydb
  sensitive_tools:
    - execute_query
  call_timeout_ms: 60000
`;
    const result = parseSporeManifest(yaml);
    expect(result.mcp_server).toBeDefined();
    expect(result.mcp_server?.command).toBe('/usr/local/bin/mcp-postgres');
    expect(result.mcp_server?.args).toEqual(['--port', '5432']);
    expect(result.mcp_server?.env).toEqual({ DB_URL: 'postgres://localhost/mydb' });
    expect(result.mcp_server?.sensitive_tools).toEqual(['execute_query']);
    expect(result.mcp_server?.call_timeout_ms).toBe(60000);
  });

  it('mcp_server present with only command — args/env/sensitive_tools default correctly', () => {
    const yaml = `
name: simple-mcp
description: Minimal MCP spore.
version: 1.0.0
accent_color: "#ffffff"
mcp_server:
  command: /usr/bin/my-mcp-server
`;
    const result = parseSporeManifest(yaml);
    expect(result.mcp_server?.command).toBe('/usr/bin/my-mcp-server');
    expect(result.mcp_server?.args).toEqual([]);
    expect(result.mcp_server?.env).toEqual({});
    expect(result.mcp_server?.sensitive_tools).toEqual([]);
    expect(result.mcp_server?.call_timeout_ms).toBeUndefined();
  });

  it('mcp_server.command empty string — fails validation', () => {
    const yaml = `
name: bad-spore
description: Empty command.
version: 1.0.0
accent_color: "#000000"
mcp_server:
  command: ""
`;
    expect(() => parseSporeManifest(yaml)).toThrow(/mcp_server\.command/);
  });

  it('mcp_server.command absent entirely — fails validation (command is required)', () => {
    const yaml = `
name: foo
description: A spore with mcp_server but no command key.
version: 1.0.0
accent_color: "#000000"
mcp_server:
  args: []
`;
    expect(() => parseSporeManifest(yaml)).toThrow(/mcp_server\.command/);
  });

  it('mcp_server.sensitive_tools containing a non-string — fails validation', () => {
    const yaml = `
name: bad-spore
description: Non-string in sensitive_tools.
version: 1.0.0
accent_color: "#000000"
mcp_server:
  command: /usr/bin/mcp
  sensitive_tools:
    - 42
`;
    expect(() => parseSporeManifest(yaml)).toThrow(/sensitive_tools/);
  });

  it('mcp_server.call_timeout_ms zero — fails (positive int required)', () => {
    const yaml = `
name: bad-spore
description: Zero timeout.
version: 1.0.0
accent_color: "#000000"
mcp_server:
  command: /usr/bin/mcp
  call_timeout_ms: 0
`;
    expect(() => parseSporeManifest(yaml)).toThrow(/call_timeout_ms/);
  });

  it('mcp_server.call_timeout_ms negative — fails', () => {
    const yaml = `
name: bad-spore
description: Negative timeout.
version: 1.0.0
accent_color: "#000000"
mcp_server:
  command: /usr/bin/mcp
  call_timeout_ms: -500
`;
    expect(() => parseSporeManifest(yaml)).toThrow(/call_timeout_ms/);
  });

  it('mcp_server.call_timeout_ms non-integer (1.5) — fails', () => {
    const yaml = `
name: bad-spore
description: Float timeout.
version: 1.0.0
accent_color: "#000000"
mcp_server:
  command: /usr/bin/mcp
  call_timeout_ms: 1.5
`;
    expect(() => parseSporeManifest(yaml)).toThrow(/call_timeout_ms/);
  });

  it('unknown top-level key still fails — .strict() preserved (regression for .extend() trap)', () => {
    const yaml = `
name: strict-test
description: Testing strict mode.
version: 1.0.0
accent_color: "#abcdef"
unknown_top_level_key: should-fail
`;
    expect(() => parseSporeManifest(yaml)).toThrow(/Unrecognized key/);
  });
});
