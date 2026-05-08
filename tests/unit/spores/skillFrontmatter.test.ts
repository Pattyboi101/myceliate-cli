// tests/unit/spores/skillFrontmatter.test.ts
import { describe, expect, it } from 'vitest';
import { parseSkillFrontmatter } from '../../../src/spores/skillFrontmatter.js';

describe('parseSkillFrontmatter', () => {
  it('extracts frontmatter and body from a SKILL.md', () => {
    const md = `---
name: ceo
description: Drafts strategy memos and exec-level decisions.
---

# CEO

You are the CEO persona.
`;
    const result = parseSkillFrontmatter(md);
    expect(result.frontmatter.name).toBe('ceo');
    expect(result.frontmatter.description).toMatch(/strategy/);
    expect(result.body.trim()).toMatch(/^# CEO/);
  });

  it('rejects file without frontmatter', () => {
    const md = '# No frontmatter\n\nbody';
    expect(() => parseSkillFrontmatter(md)).toThrow(/frontmatter/);
  });

  it('rejects frontmatter with description over 200 chars', () => {
    const longDesc = 'x'.repeat(201);
    const md = `---
name: foo
description: ${longDesc}
---

body
`;
    expect(() => parseSkillFrontmatter(md)).toThrow(/description/);
  });

  it('rejects non-kebab name', () => {
    const md = `---
name: NotKebab
description: bar
---

body
`;
    expect(() => parseSkillFrontmatter(md)).toThrow(/name/);
  });
});
