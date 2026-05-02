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
    expect(out.split('\n').sort()).toEqual(['a.txt', 'b.txt', 'sub']);
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
});
