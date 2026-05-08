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
