// tests/unit/ui/ContentStream.test.tsx
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { ContentStream } from '../../../src/ui/ContentStream.js';

describe('ContentStream', () => {
  it('renders incoming chunks as they arrive', () => {
    const { lastFrame, rerender } = render(<ContentStream text="hello" />);
    expect(lastFrame()).toContain('hello');
    rerender(<ContentStream text={"hello\n\n# H1\n\n"} />);
    expect(lastFrame()).toContain('# H1');
  });
});
