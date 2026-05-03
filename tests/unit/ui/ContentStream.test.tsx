import { render } from 'ink-testing-library';
import React from 'react';
// tests/unit/ui/ContentStream.test.tsx
import { describe, expect, it } from 'vitest';
import { ContentStream } from '../../../src/ui/ContentStream.js';

describe('ContentStream', () => {
  it('renders incoming chunks as they arrive', () => {
    const { lastFrame, rerender } = render(<ContentStream text="hello" />);
    expect(lastFrame()).toContain('hello');
    rerender(<ContentStream text={'hello\n\n# H1\n\n'} />);
    expect(lastFrame()).toContain('# H1');
  });
});
