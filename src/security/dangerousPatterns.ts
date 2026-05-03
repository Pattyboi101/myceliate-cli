// src/security/dangerousPatterns.ts

/**
 * A discriminated union verdict from `isDangerous`.
 * When `dangerous` is true, `reason` carries a human-readable explanation
 * for the HITL approval prompt.
 */
export type Verdict = { dangerous: true; reason: string } | { dangerous: false };

/**
 * Static blocklist of shell command signatures that warrant HITL interception.
 *
 * Rules:
 * - Patterns are regex-only — no LLM judgement (R11).
 * - False positives (blocking a benign command) are acceptable.
 *   False negatives (allowing a destructive command) are a critical bug.
 * - Regexes are case-sensitive. Uppercase variants (RM -RF) are not caught.
 *   This is a deliberate conservative choice: uncommon shell aliases produce
 *   fewer false positives, and the primary threat model is script injection,
 *   not interactive typos.
 * - The `\bsudo\b` pattern matches "sudo" anywhere in the command string.
 *   This is intentionally aggressive — e.g. `echo "sudo manual"` would trip.
 *   Accepted false positive per the conservative security posture of v1.
 */
const PATTERNS: { re: RegExp; reason: string }[] = [
  // Defect #2 fix: trailing \b dropped — `/`, `~`, `*` are non-word chars and
  // end-of-string after a non-word char does not constitute a JS word boundary.
  // The path-prefix chars are themselves the discriminator; no trailing anchor needed.
  { re: /\brm\s+-rf?\s+(?:\/|~|\$HOME|\*)/, reason: 'recursive delete on root/home/glob' },
  {
    re: /\b(?:curl|wget|fetch)\b[^\n]*\|\s*(?:sh|bash|zsh)\b/,
    reason: 'pipe network response into shell',
  },
  { re: /\bsudo\b/, reason: 'sudo escalation' },
  { re: /:\(\)\s*\{[^}]*:\|:[^}]*\}\s*;\s*:/, reason: 'fork bomb' },
  { re: /\bmkfs\b|\bdd\s+if=.*of=\/dev\b/, reason: 'filesystem destruction' },
  { re: /\bchmod\s+-R\s+777\s+\//, reason: 'world-writable on root' },
  { re: /\b(?:shutdown|reboot|halt|poweroff)\b/, reason: 'system power state' },
];

/**
 * Determine whether `command` matches any known dangerous shell pattern.
 *
 * Returns `{ dangerous: true, reason }` on a match, or `{ dangerous: false }`
 * if all patterns pass. Evaluation short-circuits on the first match.
 */
export function isDangerous(command: string): Verdict {
  for (const p of PATTERNS) {
    if (p.re.test(command)) return { dangerous: true, reason: p.reason };
  }
  return { dangerous: false };
}
