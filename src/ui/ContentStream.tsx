// src/ui/ContentStream.tsx
import type React from 'react';
import { useMemo } from 'react';
import { MarkdownRenderer } from './markdown/MarkdownRenderer.js';
import { IncrementalMarkdownParser } from './markdown/incrementalParser.js';

export function ContentStream({ text }: { text: string }): React.JSX.Element {
  // Re-parse from scratch on each render. The parser itself is O(n); we accept
  // the per-render allocation for simplicity. For a long-running session, lift
  // the parser into a ref and feed only the delta.
  const { blocks, open } = useMemo(() => {
    const p = new IncrementalMarkdownParser();
    p.feed(text);
    return { blocks: p.completedBlocks(), open: p.openBlock() };
  }, [text]);
  return <MarkdownRenderer blocks={blocks} open={open} />;
}
