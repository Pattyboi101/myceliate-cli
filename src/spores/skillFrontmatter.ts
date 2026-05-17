import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

const KEBAB = /^[a-z][a-z0-9-]*$/;

export const SkillFrontmatterSchema = z
  .object({
    name: z.string().regex(KEBAB, 'name must be kebab-case'),
    description: z
      .string()
      .min(1)
      .max(
        200,
        'description must be ≤ 200 chars (it gets injected into the orchestrator system prompt)',
      ),
    'argument-hint': z.string().min(1).max(80).optional(),
  })
  .strict();

export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;

export interface ParsedSkill {
  frontmatter: SkillFrontmatter;
  body: string;
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;

export class SkillFrontmatterError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'SkillFrontmatterError';
  }
}

export function parseSkillFrontmatter(content: string): ParsedSkill {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) {
    throw new SkillFrontmatterError('SKILL.md missing frontmatter (must start with --- ... ---)');
  }
  const [, fmRaw, body] = match;
  if (fmRaw === undefined || body === undefined) {
    throw new SkillFrontmatterError('SKILL.md frontmatter regex matched but groups missing');
  }
  let parsedFm: unknown;
  try {
    parsedFm = parseYaml(fmRaw);
  } catch (cause) {
    throw new SkillFrontmatterError('Invalid YAML in SKILL.md frontmatter', cause);
  }
  const result = SkillFrontmatterSchema.safeParse(parsedFm);
  if (!result.success) {
    throw new SkillFrontmatterError(
      `Frontmatter validation failed: ${result.error.issues.map((i) => i.message).join('; ')}`,
      result.error,
    );
  }
  return { frontmatter: result.data, body };
}
