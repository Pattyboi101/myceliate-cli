// tests/unit/tools/lightweightTools.test.ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { grepTool } from '../../../src/tools/grep.js';
import { listDirTool } from '../../../src/tools/listDir.js';
import { readFileTool } from '../../../src/tools/readFile.js';
import { ToolRegistry } from '../../../src/tools/registry.js';
import { writeFileTool } from '../../../src/tools/writeFile.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'myc-tools-'));
  await writeFile(join(tmp, 'a.txt'), 'hello world\nfoo bar\nhello again');
  await writeFile(join(tmp, 'b.txt'), 'nothing matches');
  // For grep subdirectory recursion test (lesson #5)
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(tmp, 'sub'), { recursive: true });
  await writeFile(join(tmp, 'sub', 'c.txt'), 'hello from subdirectory');
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('lightweight tools', () => {
  it('readFile returns the contents', async () => {
    const r = new ToolRegistry();
    r.register(readFileTool);
    const out = await r.invoke('read_file', { path: join(tmp, 'a.txt') });
    expect(out).toBe('hello world\nfoo bar\nhello again');
  });

  it('writeFile writes to disk', async () => {
    const r = new ToolRegistry();
    r.register(writeFileTool);
    await r.invoke('write_file', { path: join(tmp, 'c.txt'), content: 'new' });
    const r2 = new ToolRegistry();
    r2.register(readFileTool);
    expect(await r2.invoke('read_file', { path: join(tmp, 'c.txt') })).toBe('new');
  });

  it('listDir returns sorted entries', async () => {
    const r = new ToolRegistry();
    r.register(listDirTool);
    const out = await r.invoke('list_dir', { path: tmp });
    // Direct comparison — re-sorting in the test would mask a regression in listDir's sort
    expect(out).toBe('a.txt\nb.txt\nsub');
  });

  it('grep returns matching path:line:text triples', async () => {
    const r = new ToolRegistry();
    r.register(grepTool);
    // Invoke grep only on the root-level a.txt by passing the file directly
    const out = await r.invoke('grep', { pattern: 'hello', path: join(tmp, 'a.txt') });
    const lines = out.split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/a\.txt:1:hello world/);
    expect(lines[1]).toMatch(/a\.txt:3:hello again/);
  });

  // Additional contract-coverage cases (lesson #5)

  it('writeFile creates missing parent directories', async () => {
    const r = new ToolRegistry();
    r.register(writeFileTool);
    const nestedPath = join(tmp, 'sub', 'dir', 'c.txt');
    await r.invoke('write_file', { path: nestedPath, content: 'nested' });
    const r2 = new ToolRegistry();
    r2.register(readFileTool);
    expect(await r2.invoke('read_file', { path: nestedPath })).toBe('nested');
  });

  it('listDir on empty dir returns empty string', async () => {
    const { mkdir } = await import('node:fs/promises');
    const emptyDir = join(tmp, 'empty');
    await mkdir(emptyDir);
    const r = new ToolRegistry();
    r.register(listDirTool);
    const out = await r.invoke('list_dir', { path: emptyDir });
    expect(out).toBe('');
  });

  // Phase 16 review (MAJOR-1): listDir tool must apply the secret-file filter
  // so an execution sub-agent cannot bypass the senseContext system-prompt filter
  // by calling list_dir directly. The filter is shared with senseContext via
  // `src/security/secretFileFilter.ts`.
  it('listDir filters secret-adjacent filenames from the tool result', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const sandbox = join(tmp, 'secret-sandbox');
    await mkdir(sandbox);
    await writeFile(join(sandbox, '.env'), 'DEEPSEEK_API_KEY=secret');
    await writeFile(join(sandbox, '.env.staging'), 'STAGING=1');
    await writeFile(join(sandbox, 'README.md'), 'public');
    await writeFile(join(sandbox, 'id_rsa'), 'private');
    await writeFile(join(sandbox, 'tls.key'), 'private');
    await writeFile(join(sandbox, 'cert.pem'), 'pem block');
    await writeFile(join(sandbox, 'creds.gpg'), 'gpg blob');
    await writeFile(join(sandbox, '.npmrc'), 'token');
    await mkdir(join(sandbox, '.git'));
    await mkdir(join(sandbox, 'src'));

    const r = new ToolRegistry();
    r.register(listDirTool);
    const out = await r.invoke('list_dir', { path: sandbox });
    const entries = out.split('\n').filter(Boolean);

    expect(entries).not.toContain('.env');
    expect(entries).not.toContain('.env.staging');
    expect(entries).not.toContain('.git');
    expect(entries).not.toContain('id_rsa');
    expect(entries).not.toContain('tls.key');
    expect(entries).not.toContain('cert.pem');
    expect(entries).not.toContain('creds.gpg');
    expect(entries).not.toContain('.npmrc');
    expect(entries).toContain('README.md');
    expect(entries).toContain('src');
  });

  it('grep with zero matches returns empty string', async () => {
    const r = new ToolRegistry();
    r.register(grepTool);
    const out = await r.invoke('grep', { pattern: 'zzznomatch', path: tmp });
    expect(out).toBe('');
  });

  it('grep recurses into subdirectories', async () => {
    const r = new ToolRegistry();
    r.register(grepTool);
    const out = await r.invoke('grep', { pattern: 'hello', path: tmp });
    const lines = out.split('\n').filter(Boolean);
    // Should match a.txt (2 lines) and sub/c.txt (1 line)
    expect(lines.length).toBeGreaterThanOrEqual(3);
    const hasSubMatch = lines.some(
      (l) => l.includes('c.txt') && l.includes('hello from subdirectory'),
    );
    expect(hasSubMatch).toBe(true);
  });

  it('grep rejects malformed regex with a SyntaxError', async () => {
    const r = new ToolRegistry();
    r.register(grepTool);
    await expect(r.invoke('grep', { pattern: '[invalid', path: tmp })).rejects.toThrow(SyntaxError);
  });

  it('grep skips symlinks so circular links cannot hang the walk', async () => {
    const { mkdir, symlink } = await import('node:fs/promises');
    const cycleDir = join(tmp, 'cyclic');
    await mkdir(cycleDir);
    // Circular: tmp/cyclic/parent_link -> tmp.  If grep followed symlinks, it would loop.
    await symlink(tmp, join(cycleDir, 'parent_link'));
    const r = new ToolRegistry();
    r.register(grepTool);
    const out = await r.invoke('grep', { pattern: 'hello', path: tmp });
    const lines = out.split('\n').filter(Boolean);
    // Exactly 3: a.txt:1, a.txt:3, sub/c.txt:1 — no extras from the symlink
    expect(lines).toHaveLength(3);
  });
});
