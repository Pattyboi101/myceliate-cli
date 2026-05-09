import { describe, expect, it } from 'vitest';
import { parseSporeManifest } from '../../../src/spores/SporeManifest.js';

const baseFields = `
name: research
description: Research.
version: 1.0.0
accent_color: "#4a90c4"
`;

describe('SporeManifest.allowed_tools', () => {
  it('accepts manifest WITHOUT allowed_tools (legacy compat)', () => {
    const m = parseSporeManifest(baseFields);
    expect(m.allowed_tools).toBeUndefined();
  });

  it('accepts allowed_tools as a non-empty string array', () => {
    const m = parseSporeManifest(`${baseFields}\nallowed_tools: [read_file, grep, list_dir]`);
    expect(m.allowed_tools).toEqual(['read_file', 'grep', 'list_dir']);
  });

  it('accepts allowed_tools as an empty array (zero execution tools)', () => {
    const m = parseSporeManifest(`${baseFields}\nallowed_tools: []`);
    expect(m.allowed_tools).toEqual([]);
  });

  it('rejects allowed_tools with non-string entries', () => {
    expect(() =>
      parseSporeManifest(`${baseFields}\nallowed_tools: [read_file, 42, list_dir]`),
    ).toThrow(/allowed_tools/);
  });

  it('rejects allowed_tools that is not an array', () => {
    expect(() =>
      parseSporeManifest(`${baseFields}\nallowed_tools: read_file`),
    ).toThrow();
  });
});
