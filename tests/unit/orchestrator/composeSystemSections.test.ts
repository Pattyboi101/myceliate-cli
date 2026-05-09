import { describe, expect, it } from 'vitest';
import { composeSystemSections } from '../../../src/orchestrator/composeSystemSections.js';
import type { CommandRecord } from '../../../src/spores/CommandRecord.js';
import type { Spore } from '../../../src/spores/Spore.js';
import { SporeRegistry } from '../../../src/spores/SporeRegistry.js';

function fakeRegistry(spores: Spore[]): SporeRegistry {
  return SporeRegistry.fromList(spores);
}

function mkSpore(
  name: string,
  opts: { description: string; accent_color: string; commands?: CommandRecord[] },
): Spore {
  return {
    name,
    tier: 'bundled',
    dir: `/fake/${name}`,
    manifest: {
      name,
      description: opts.description,
      version: '1.0.0',
      accent_color: opts.accent_color,
      keywords: [],
      agents: [],
    },
    sectorFrontmatter: { name, description: opts.description },
    sectorSkillPath: `/fake/${name}/SKILL.md`,
    personas: [],
    commands: opts.commands ?? [],
  };
}

describe('composeSystemSections', () => {
  it('lists every loaded sector with name, accent_color, description', () => {
    const reg = fakeRegistry([
      mkSpore('research', { description: 'Academic research workflows.', accent_color: '#4a90c4' }),
      mkSpore('coding', { description: 'Software engineering tasks.', accent_color: '#7d9b3d' }),
    ]);
    const out = composeSystemSections({ registry: reg, activeSpore: null });
    expect(out).toContain('research');
    expect(out).toContain('Academic research workflows.');
    expect(out).toContain('#4a90c4');
    expect(out).toContain('coding');
    expect(out).toContain('Software engineering tasks.');
  });

  it('does NOT list any commands when no spore is active', () => {
    const reg = fakeRegistry([
      mkSpore('research', {
        description: 'Academic research workflows.',
        accent_color: '#4a90c4',
        commands: [{ name: 'lit-review', description: 'lit review', bodyPath: '/fake/lit.md' }],
      }),
    ]);
    const out = composeSystemSections({ registry: reg, activeSpore: null });
    expect(out).not.toContain('lit-review');
    expect(out).not.toContain('research:lit-review');
  });

  it('lists ONLY the active spore commands when a spore is active', () => {
    const reg = fakeRegistry([
      mkSpore('research', {
        description: 'Research.',
        accent_color: '#4a90c4',
        commands: [
          { name: 'lit-review', description: 'Lit review summary.', bodyPath: '/fake/lit.md' },
        ],
      }),
      mkSpore('coding', {
        description: 'Coding.',
        accent_color: '#7d9b3d',
        commands: [
          { name: 'scaffold', description: 'Scaffold a new module.', bodyPath: '/fake/sc.md' },
        ],
      }),
    ]);
    const out = composeSystemSections({ registry: reg, activeSpore: 'research' });
    expect(out).toContain('research:lit-review');
    expect(out).toContain('Lit review summary.');
    expect(out).not.toContain('coding:scaffold');
    expect(out).not.toContain('Scaffold a new module.');
  });

  it('returns empty string when no sectors are loaded (--no-spore mode)', () => {
    const reg = fakeRegistry([]);
    const out = composeSystemSections({ registry: reg, activeSpore: null });
    expect(out).toBe('');
  });

  it('handles an active spore that has zero commands gracefully', () => {
    const reg = fakeRegistry([
      mkSpore('research', { description: 'Research.', accent_color: '#4a90c4', commands: [] }),
    ]);
    const out = composeSystemSections({ registry: reg, activeSpore: 'research' });
    expect(out).toContain('research');
    expect(out).not.toContain('Available commands');
  });
});
