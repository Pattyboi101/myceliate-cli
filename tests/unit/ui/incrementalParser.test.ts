// tests/unit/ui/incrementalParser.test.ts
import { describe, expect, it } from 'vitest';
import {
  type Block,
  IncrementalMarkdownParser,
} from '../../../src/ui/markdown/incrementalParser.js';

describe('IncrementalMarkdownParser', () => {
  it('locks a paragraph when a blank line follows', () => {
    const p = new IncrementalMarkdownParser();
    p.feed('hello world');
    expect(p.completedBlocks()).toHaveLength(0);
    p.feed('\n\nnext line');
    const completed = p.completedBlocks();
    expect(completed).toHaveLength(1);
    expect(completed[0]).toEqual<Block>({ type: 'paragraph', text: 'hello world' });
  });

  it('detects fenced code blocks with language tag', () => {
    const p = new IncrementalMarkdownParser();
    p.feed('```ts\nconst x = 1;\n```\n\nafter');
    const completed = p.completedBlocks();
    expect(completed[0]).toEqual<Block>({ type: 'code', language: 'ts', text: 'const x = 1;' });
  });

  it('detects ATX headings', () => {
    const p = new IncrementalMarkdownParser();
    p.feed('# Title\n\nbody\n\n');
    const completed = p.completedBlocks();
    expect(completed[0]).toEqual<Block>({ type: 'heading', level: 1, text: 'Title' });
    expect(completed[1]).toEqual<Block>({ type: 'paragraph', text: 'body' });
  });

  it('returns the open trailing block separately', () => {
    const p = new IncrementalMarkdownParser();
    p.feed('first paragraph\n\nsecond para');
    expect(p.completedBlocks()).toHaveLength(1);
    expect(p.openBlock()).toEqual<Block>({ type: 'paragraph', text: 'second para' });
  });

  it('is O(n): processing a 100k-char feed runs in linear time', () => {
    const p = new IncrementalMarkdownParser();
    const big = 'para\n\n'.repeat(20_000); // 120k chars, 20k completed blocks
    const t0 = performance.now();
    p.feed(big);
    const elapsed = performance.now() - t0;
    expect(p.completedBlocks().length).toBe(20_000);
    expect(elapsed).toBeLessThan(500); // generous; linear should be << 500ms
  });
});
