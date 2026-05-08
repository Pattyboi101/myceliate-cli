import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

const KEBAB = /^[a-z][a-z0-9-]*$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export const SporeManifestSchema = z
  .object({
    name: z.string().regex(KEBAB, 'name must be kebab-case (lowercase, digits, hyphens)'),
    description: z.string().min(1).max(2000),
    version: z.string().regex(SEMVER, 'version must be semver (e.g. 1.0.0)'),
    accent_color: z
      .string()
      .regex(HEX_COLOR, 'accent_color must be a 6-digit hex string (e.g. "#c5a45f")'),
    keywords: z.array(z.string()).default([]),
    agents: z.array(z.string().regex(KEBAB, 'agent names must be kebab-case')).default([]),
  })
  .strict();

export type SporeManifest = z.infer<typeof SporeManifestSchema>;

export class SporeManifestParseError extends Error {
  constructor(
    message: string,
    override readonly cause: unknown,
  ) {
    super(message);
    this.name = 'SporeManifestParseError';
  }
}

export function parseSporeManifest(yamlContent: string): SporeManifest {
  let raw: unknown;
  try {
    raw = parseYaml(yamlContent);
  } catch (cause) {
    throw new SporeManifestParseError('Invalid YAML in manifest', cause);
  }
  const result = SporeManifestSchema.safeParse(raw);
  if (!result.success) {
    throw new SporeManifestParseError(
      `Manifest validation failed: ${result.error.issues.map((i) => i.message).join('; ')}`,
      result.error,
    );
  }
  return result.data;
}
