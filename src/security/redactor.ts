// src/security/redactor.ts

type Pattern = { kind: string; re: RegExp };

/**
 * Ordered list of secret patterns. Order matters: more specific patterns must
 * precede broader ones to avoid one pattern swallowing a match that belongs to
 * another. Specifically, `anthropic_key` must precede `openai_key` because the
 * `sk-` prefix in `openai_key` would otherwise greedily match `sk-ant-...` keys
 * before the Anthropic-specific pattern has a chance to fire.
 */
const PATTERNS: Pattern[] = [
  { kind: 'anthropic_key', re: /sk-ant-[a-z0-9-]+-[A-Za-z0-9_-]{20,}/g },
  { kind: 'openai_key', re: /sk-(?:proj|live|test)?-?[A-Za-z0-9_-]{20,}/g },
  { kind: 'jwt', re: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g },
  { kind: 'pem', re: /-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g },
  {
    kind: 'env_value',
    re: /\b(?:API_KEY|SECRET|TOKEN|PASSWORD|DATABASE_URL|REDIS_URL|DEEPSEEK_API_KEY)=\S+/gi,
  },
];

/**
 * Scrub known secret shapes from `input` before the string is sent to an LLM
 * endpoint or written to the conversation log.
 *
 * This is a deterministic regex pipeline — it does NOT delegate the redaction
 * decision to the LLM (R11). False positives (over-redacting a benign string)
 * are acceptable; false negatives (leaking a credential) are a critical bug.
 *
 * Each match is replaced with `[REDACTED:<kind>]`. For env-style assignments
 * (`KEY=value`) the key name is preserved so context is not lost: `KEY=[REDACTED:env_value]`.
 */
export function redactSecrets(input: string): string {
  let out = input;
  for (const { kind, re } of PATTERNS) {
    out = out.replace(re, (match) => {
      // For env-style assignments, preserve the key name.
      if (kind === 'env_value') {
        const eq = match.indexOf('=');
        return `${match.slice(0, eq + 1)}[REDACTED:env_value]`;
      }
      return `[REDACTED:${kind}]`;
    });
  }
  return out;
}
