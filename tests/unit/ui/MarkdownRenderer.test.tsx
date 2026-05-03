// tests/unit/ui/MarkdownRenderer.test.tsx
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { MarkdownRenderer } from '../../../src/ui/markdown/MarkdownRenderer.js';
import type { Block } from '../../../src/ui/markdown/incrementalParser.js';

describe('MarkdownRenderer', () => {
  it('renders headings with leading hashes', () => {
    const blocks: Block[] = [{ type: 'heading', level: 2, text: 'Hi' }];
    const { lastFrame } = render(<MarkdownRenderer blocks={blocks} open={null} />);
    expect(lastFrame()).toContain('## Hi');
  });

  it('renders fenced code with language label', () => {
    const blocks: Block[] = [{ type: 'code', language: 'ts', text: 'const x = 1;' }];
    const { lastFrame } = render(<MarkdownRenderer blocks={blocks} open={null} />);
    expect(lastFrame()).toContain('ts');
    expect(lastFrame()).toContain('const x = 1;');
  });

  it('renders paragraphs and the open block', () => {
    const blocks: Block[] = [{ type: 'paragraph', text: 'first' }];
    const { lastFrame } = render(<MarkdownRenderer blocks={blocks} open={{ type: 'paragraph', text: 'open…' }} />);
    expect(lastFrame()).toContain('first');
    expect(lastFrame()).toContain('open…');
  });
});
