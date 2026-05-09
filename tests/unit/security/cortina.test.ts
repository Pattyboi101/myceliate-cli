// tests/unit/security/cortina.test.ts
//
// v1.5 Cortina security layer tests. Covers HitlGate.checkWrite (cwd
// confinement) and HitlGate.checkRead (sensitive-path gating), and the
// integration with createWriteFileTool / createReadFileTool.
//
// The orchestrator-side tests in tests/unit/security/hitlGate.test.ts already
// cover checkBash; this file focuses exclusively on the file-tool gates added
// in v1.5 Phase 1.5 (Cortina).

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HitlGate } from '../../../src/security/hitlGate.js';
import { createReadFileTool } from '../../../src/tools/readFile.js';
import { createWriteFileTool } from '../../../src/tools/writeFile.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'cortina-'));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('HitlGate.checkWrite — cwd confinement', () => {
  it('allows writes inside cwd silently (no approval prompt)', async () => {
    const requestApproval = vi.fn();
    const hitl = new HitlGate({ requestApproval });
    const verdict = await hitl.checkWrite({
      path: join(tmp, 'inside.txt'),
      cwd: tmp,
      requestId: 'req-1',
    });
    expect(verdict.allowed).toBe(true);
    expect(verdict).toMatchObject({ requiredApproval: false });
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('treats relative paths as cwd-relative and allows them', async () => {
    const requestApproval = vi.fn();
    const hitl = new HitlGate({ requestApproval });
    const verdict = await hitl.checkWrite({
      path: 'sub/file.txt',
      cwd: tmp,
      requestId: 'req-2',
    });
    expect(verdict.allowed).toBe(true);
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('requires approval for absolute writes outside cwd', async () => {
    const requestApproval = vi.fn().mockResolvedValue({ decision: 'approve' as const });
    const hitl = new HitlGate({ requestApproval });
    const outsidePath = '/tmp/some-other-place/leak.txt';
    const verdict = await hitl.checkWrite({
      path: outsidePath,
      cwd: tmp,
      requestId: 'req-3',
    });
    expect(verdict.allowed).toBe(true);
    expect(verdict).toMatchObject({ requiredApproval: true });
    expect(requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'req-3',
        command: expect.stringContaining('write_file →'),
        reason: expect.stringContaining('write outside cwd'),
      }),
    );
  });

  it('returns rejected verdict when user rejects out-of-cwd write', async () => {
    const requestApproval = vi
      .fn()
      .mockResolvedValue({ decision: 'reject' as const, feedback: 'no thanks' });
    const hitl = new HitlGate({ requestApproval });
    const verdict = await hitl.checkWrite({
      path: '/etc/passwd',
      cwd: tmp,
      requestId: 'req-4',
    });
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed === false) {
      expect(verdict.feedback).toBe('no thanks');
    }
  });
});

describe('HitlGate.checkRead — sensitive path gating', () => {
  it('allows reads of non-sensitive paths silently', async () => {
    const requestApproval = vi.fn();
    const hitl = new HitlGate({ requestApproval });
    const verdict = await hitl.checkRead({
      path: join(tmp, 'normal.txt'),
      requestId: 'req-5',
    });
    expect(verdict.allowed).toBe(true);
    expect(requestApproval).not.toHaveBeenCalled();
  });

  // Sensitive paths matrix — each pattern must trigger approval. One row per
  // entry in SENSITIVE_READ_PATTERNS plus per-alternative coverage for the
  // shell-startup and system-account regex groups (so a future regex tweak
  // that drops .zshrc or shadow gets caught).
  it.each([
    ['/home/user/.ssh/id_rsa', 'SSH'],
    ['/home/user/.aws/credentials', 'AWS'],
    ['/home/user/.config/gcloud/credentials.db', 'GCP'],
    ['/home/user/.kube/config', 'Kubernetes'],
    ['/home/user/.docker/config.json', 'Docker'],
    ['/home/user/.gnupg/private-keys-v1.d/abc.key', 'GPG'],
    ['/home/user/.netrc', '.netrc'],
    ['/home/user/.npmrc', 'npm'],
    ['/home/user/.pypirc', 'pypi'],
    ['/home/user/.bashrc', 'shell startup — bashrc'],
    ['/home/user/.zshrc', 'shell startup — zshrc'],
    ['/home/user/.profile', 'shell startup — profile'],
    ['/home/user/.bash_profile', 'shell startup — bash_profile'],
    ['/home/user/.zprofile', 'shell startup — zprofile'],
    ['/etc/passwd', 'system account — passwd'],
    ['/etc/shadow', 'system account — shadow'],
    ['/etc/sudoers', 'sudo'],
    ['/proc/self/environ', 'process environment'],
  ])('requires approval for sensitive read of %s (%s)', async (path, _label) => {
    const requestApproval = vi.fn().mockResolvedValue({ decision: 'reject' as const });
    const hitl = new HitlGate({ requestApproval });
    const verdict = await hitl.checkRead({ path, requestId: 'req-6' });
    expect(requestApproval).toHaveBeenCalled();
    expect(verdict.allowed).toBe(false);
  });
});

describe('write_file tool — Cortina integration', () => {
  it('writes inside cwd without invoking HITL', async () => {
    const requestApproval = vi.fn();
    const hitl = new HitlGate({ requestApproval });
    const tool = createWriteFileTool({ hitl });
    const path = join(tmp, 'ok.txt');
    const result = await tool.run(
      { path, content: 'hello' },
      { cwd: tmp, abort: new AbortController().signal, toolUseId: 'tu-1' },
    );
    expect(result).toContain('wrote');
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('throws "HITL rejected:" when user rejects an outside-cwd write', async () => {
    const requestApproval = vi
      .fn()
      .mockResolvedValue({ decision: 'reject' as const, feedback: 'no' });
    const hitl = new HitlGate({ requestApproval });
    const tool = createWriteFileTool({ hitl });
    await expect(
      tool.run(
        { path: '/etc/passwd', content: 'evil' },
        { cwd: tmp, abort: new AbortController().signal, toolUseId: 'tu-2' },
      ),
    ).rejects.toThrow(/HITL rejected:/);
  });
});

describe('read_file tool — Cortina integration', () => {
  it('reads non-sensitive paths without invoking HITL', async () => {
    const { writeFile } = await import('node:fs/promises');
    const path = join(tmp, 'plain.txt');
    await writeFile(path, 'public content');

    const requestApproval = vi.fn();
    const hitl = new HitlGate({ requestApproval });
    const tool = createReadFileTool({ hitl });
    const result = await tool.run(
      { path },
      { cwd: tmp, abort: new AbortController().signal, toolUseId: 'tu-3' },
    );
    expect(result).toBe('public content');
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('throws "HITL rejected:" when user rejects a sensitive read', async () => {
    const requestApproval = vi.fn().mockResolvedValue({ decision: 'reject' as const });
    const hitl = new HitlGate({ requestApproval });
    const tool = createReadFileTool({ hitl });
    await expect(
      tool.run(
        { path: '/etc/passwd' },
        { cwd: tmp, abort: new AbortController().signal, toolUseId: 'tu-4' },
      ),
    ).rejects.toThrow(/HITL rejected:/);
  });
});
