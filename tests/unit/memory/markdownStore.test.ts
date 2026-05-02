import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// tests/unit/memory/markdownStore.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MarkdownStore } from '../../../src/memory/markdownStore.js';
import type { ArtifactPointer } from '../../../src/memory/markdownStore.js';

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'myc-mem-'));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('MarkdownStore', () => {
  it('writes and reads back a record with frontmatter', async () => {
    const s = new MarkdownStore(tmp);
    await s.write('skills/grep.md', { title: 'Grep skill', tags: ['search'] }, 'Use grep for...');
    const read = await s.read('skills/grep.md');
    expect(read.frontmatter).toEqual({ title: 'Grep skill', tags: ['search'] });
    expect(read.body).toBe('Use grep for...');
  });

  it('appends to an existing file without rewriting frontmatter', async () => {
    const s = new MarkdownStore(tmp);
    await s.write('history/s1.md', { sessionId: 's1' }, '# turn 1\nhello');
    await s.append('history/s1.md', '\n\n# turn 2\nworld');
    const read = await s.read('history/s1.md');
    expect(read.body).toContain('# turn 1');
    expect(read.body).toContain('# turn 2\nworld');
  });

  it('lists records under a subdirectory', async () => {
    const s = new MarkdownStore(tmp);
    await s.write('skills/a.md', {}, 'a');
    await s.write('skills/b.md', {}, 'b');
    const ls = await s.list('skills');
    expect(ls.sort()).toEqual(['skills/a.md', 'skills/b.md']);
  });

  // Additional contract tests

  it('empty frontmatter writes no frontmatter delimiters (round-trip)', async () => {
    const s = new MarkdownStore(tmp);
    await s.write('notes/empty.md', {}, 'plain body text');
    const read = await s.read('notes/empty.md');
    expect(read.frontmatter).toEqual({});
    expect(read.body).toBe('plain body text');
    // Body should not start with '---' delimiter since there is no frontmatter
    expect(read.body).not.toMatch(/^---/);
  });

  it('round-trips nested frontmatter values (tags array + numeric score)', async () => {
    const s = new MarkdownStore(tmp);
    await s.write('skills/rich.md', { tags: ['a', 'b'], score: 42 }, 'body');
    const read = await s.read('skills/rich.md');
    expect(read.frontmatter).toEqual({ tags: ['a', 'b'], score: 42 });
  });

  it('read of a missing file rejects', async () => {
    const s = new MarkdownStore(tmp);
    await expect(s.read('nonexistent/file.md')).rejects.toThrow();
  });

  it('list on a missing subdirectory returns []', async () => {
    const s = new MarkdownStore(tmp);
    const ls = await s.list('no-such-dir');
    expect(ls).toEqual([]);
  });

  // Artifact offload tests

  it('storeArtifact returns content unchanged when under threshold', async () => {
    const s = new MarkdownStore(tmp);
    const result = await s.storeArtifact('short content', { maxBytes: 4096 });
    expect(result).toBe('short content');
    // No artifacts directory should be created for under-threshold content
    await expect(access(join(tmp, 'artifacts'))).rejects.toThrow();
  });

  it('storeArtifact returns ArtifactPointer when over threshold', async () => {
    const s = new MarkdownStore(tmp);
    const largeText = 'x'.repeat(200); // over 100-byte threshold
    const result = await s.storeArtifact(largeText, { maxBytes: 100 });
    expect(typeof result).toBe('object');
    const ptr = result as ArtifactPointer;
    expect(ptr.kind).toBe('artifact');
    expect(typeof ptr.id).toBe('string');
    expect(ptr.id.length).toBeGreaterThan(0);
    expect(ptr.path).toMatch(/^artifacts\//);
    expect(ptr.bytes).toBe(largeText.length);
    // preview is first ~200 chars; since largeText is 200 'x', preview should be the whole thing
    expect(ptr.preview).toBe(largeText.slice(0, 200));
  });

  it('storeArtifact creates the artifacts directory on first offload', async () => {
    const s = new MarkdownStore(tmp);
    const largeText = 'y'.repeat(200);
    await s.storeArtifact(largeText, { maxBytes: 100 });
    // artifacts/ directory must now exist
    await expect(access(join(tmp, 'artifacts'))).resolves.toBeUndefined();
  });

  it('storeArtifact is deterministic — same content produces same pointer', async () => {
    const s = new MarkdownStore(tmp);
    const largeText = 'deterministic-content'.repeat(20); // well over 100 bytes
    const result1 = await s.storeArtifact(largeText, { maxBytes: 100 });
    const result2 = await s.storeArtifact(largeText, { maxBytes: 100 });
    expect(typeof result1).toBe('object');
    expect(typeof result2).toBe('object');
    const ptr1 = result1 as ArtifactPointer;
    const ptr2 = result2 as ArtifactPointer;
    expect(ptr1.id).toBe(ptr2.id);
    expect(ptr1.path).toBe(ptr2.path);
    expect(ptr1.bytes).toBe(ptr2.bytes);
    expect(ptr1.preview).toBe(ptr2.preview);
  });

  it('readArtifact returns the original content round-trip', async () => {
    const s = new MarkdownStore(tmp);
    const largeText = 'round-trip-content-'.repeat(20); // over 100 bytes
    const result = await s.storeArtifact(largeText, { maxBytes: 100 });
    expect(typeof result).toBe('object');
    const ptr = result as ArtifactPointer;
    const retrieved = await s.readArtifact(ptr);
    expect(retrieved).toBe(largeText);
  });
});
