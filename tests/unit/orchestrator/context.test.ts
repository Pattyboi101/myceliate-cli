// tests/unit/orchestrator/context.test.ts
import { execSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildSystemPrompt, senseContext } from '../../../src/orchestrator/context.js';

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'myc-ctx-'));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('senseContext', () => {
  it('captures cwd, claudeMd, and memory dir', async () => {
    await writeFile(join(tmp, 'CLAUDE.md'), '# rules', 'utf8');
    await mkdir(join(tmp, '.myceliate'), { recursive: true });
    const ctx = await senseContext({ cwd: tmp });
    expect(ctx.cwd).toBe(tmp);
    expect(ctx.claudeMd).toBe('# rules');
    expect(ctx.memoryDir).toBe(join(tmp, '.myceliate'));
  });

  it('handles missing CLAUDE.md gracefully', async () => {
    const ctx = await senseContext({ cwd: tmp });
    expect(ctx.claudeMd).toBe('');
  });

  it('gitStatus populates from a real git repo with dirty files', async () => {
    // init a real git repo with a dirty file
    execSync('git init', { cwd: tmp, stdio: 'ignore' });
    execSync('git config user.email "test@test.com"', { cwd: tmp, stdio: 'ignore' });
    execSync('git config user.name "Test"', { cwd: tmp, stdio: 'ignore' });
    await writeFile(join(tmp, 'dirty.txt'), 'dirty content', 'utf8');
    const ctx = await senseContext({ cwd: tmp });
    // dirty.txt should appear in status
    expect(ctx.gitStatus).toContain('dirty.txt');
  });

  it('gitStatus is empty string when cwd is not a git repo', async () => {
    // tmp is already a non-git dir (no git init)
    const ctx = await senseContext({ cwd: tmp });
    expect(ctx.gitStatus).toBe('');
  });

  it('dirEntries captures top-level files alphabetically', async () => {
    await writeFile(join(tmp, 'beta.ts'), '', 'utf8');
    await writeFile(join(tmp, 'alpha.ts'), '', 'utf8');
    await mkdir(join(tmp, 'subdir'), { recursive: true });
    const ctx = await senseContext({ cwd: tmp });
    // should be sorted, filenames only
    expect(ctx.dirEntries).toEqual(['alpha.ts', 'beta.ts', 'subdir']);
  });

  it('dirEntries returns empty array when cwd does not exist', async () => {
    const nonexistent = join(tmp, 'does-not-exist');
    const ctx = await senseContext({ cwd: nonexistent });
    expect(ctx.dirEntries).toEqual([]);
  });

  it('senseContext does not throw on any failure mode (graceful all the way down)', async () => {
    const nonexistent = join(tmp, 'no-such-dir');
    await expect(senseContext({ cwd: nonexistent })).resolves.toMatchObject({
      cwd: nonexistent,
      claudeMd: '',
      gitStatus: '',
      dirEntries: [],
    });
  });
});

it('filters secret-adjacent filenames from listDirEntries (.env, .git, .myceliate, id_rsa, *.key, *.pem)', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'myc-ctx-filter-'));
  try {
    await writeFile(join(tmp, '.env'), 'DEEPSEEK_API_KEY=secret');
    await writeFile(join(tmp, '.env.local'), 'OTHER=val');
    await writeFile(join(tmp, 'README.md'), 'public');
    await writeFile(join(tmp, 'id_rsa'), 'private key');
    await writeFile(join(tmp, 'tls.key'), 'private');
    await writeFile(join(tmp, 'cert.pem'), 'pem block');
    await writeFile(join(tmp, 'secrets.json'), '{}');
    await mkdir(join(tmp, '.git'));
    await mkdir(join(tmp, '.myceliate'));
    await mkdir(join(tmp, 'src'));

    const ctx = await senseContext({ cwd: tmp });
    expect(ctx.dirEntries).not.toContain('.env');
    expect(ctx.dirEntries).not.toContain('.env.local');
    expect(ctx.dirEntries).not.toContain('.git');
    expect(ctx.dirEntries).not.toContain('.myceliate');
    expect(ctx.dirEntries).not.toContain('id_rsa');
    expect(ctx.dirEntries).not.toContain('tls.key');
    expect(ctx.dirEntries).not.toContain('cert.pem');
    expect(ctx.dirEntries).not.toContain('secrets.json');
    expect(ctx.dirEntries).toContain('README.md');
    expect(ctx.dirEntries).toContain('src');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

describe('buildSystemPrompt', () => {
  // F5: gitStatus and dirEntries are now wired into the system prompt as
  // session ground truth. Previously senseContext populated them on every
  // session start but src/index.ts only consumed claudeMd + memoryDir.
  it('includes git porcelain output and cwd entries in the assembled prompt', () => {
    const prompt = buildSystemPrompt({
      cwd: '/tmp/x',
      claudeMd: '# project rules',
      memoryDir: '/tmp/x/.myceliate',
      gitStatus: ' M src/foo.ts\n?? new.ts',
      dirEntries: ['a.ts', 'b.ts', 'README.md'],
    });
    expect(prompt).toContain('# project rules');
    expect(prompt).toContain('## session ground truth');
    expect(prompt).toContain('git status:');
    expect(prompt).toContain(' M src/foo.ts');
    expect(prompt).toContain('?? new.ts');
    expect(prompt).toContain('cwd entries: a.ts, b.ts, README.md');
  });

  it('substitutes a fallback prompt when claudeMd is empty', () => {
    const prompt = buildSystemPrompt({
      cwd: '/tmp/x',
      claudeMd: '',
      memoryDir: '/tmp/x/.myceliate',
      gitStatus: '',
      dirEntries: [],
    });
    expect(prompt).toContain('You are myceliate, an autonomous CLI agent.');
    // Empty git status renders as the explicit "(clean / not a repo)" hint.
    expect(prompt).toContain('(clean / not a repo)');
    expect(prompt).toContain('cwd entries: ');
  });

  it('caps oversize dirEntries at 50 with an ellipsis tail', () => {
    const dirEntries = Array.from({ length: 75 }, (_, i) => `f${i}.ts`);
    const prompt = buildSystemPrompt({
      cwd: '/tmp/x',
      claudeMd: '',
      memoryDir: '/tmp/x/.myceliate',
      gitStatus: '',
      dirEntries,
    });
    expect(prompt).toContain('f0.ts');
    expect(prompt).toContain('f49.ts');
    expect(prompt).not.toContain('f50.ts');
    expect(prompt).toContain('...');
  });
});
