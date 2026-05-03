// src/ui/markdown/MarkdownRenderer.tsx
import { Box, Text } from 'ink';
import type React from 'react';
import type { Block } from './incrementalParser.js';

export function MarkdownRenderer({
  blocks,
  open,
}: { blocks: readonly Block[]; open: Block | null }): React.JSX.Element {
  return (
    <Box flexDirection="column">
      {blocks.map((b, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: completed blocks are append-only and never reordered
        <BlockView key={i} block={b} />
      ))}
      {open !== null && <BlockView block={open} dimmed />}
    </Box>
  );
}

function BlockView({ block, dimmed }: { block: Block; dimmed?: boolean }): React.JSX.Element {
  const dim = dimmed === true;
  switch (block.type) {
    case 'heading':
      return (
        <Text bold dimColor={dim}>
          {'#'.repeat(block.level)} {block.text}
        </Text>
      );
    case 'paragraph':
      return <Text dimColor={dim}>{block.text}</Text>;
    case 'code':
      return (
        <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
          <Text color="cyan" dimColor={dim}>
            {block.language}
          </Text>
          <Text dimColor={dim}>{block.text}</Text>
        </Box>
      );
  }
}
