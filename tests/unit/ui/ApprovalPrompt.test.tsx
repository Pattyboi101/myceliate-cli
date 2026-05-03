// tests/unit/ui/ApprovalPrompt.test.tsx
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { ApprovalPrompt } from '../../../src/ui/ApprovalPrompt.js';

describe('ApprovalPrompt', () => {
  it('renders the command, cwd, and reason', () => {
    const { lastFrame } = render(
      <ApprovalPrompt
        request={{ command: 'rm -rf /tmp/foo', cwd: '/work', reason: 'recursive delete' }}
        onResponse={() => {}}
      />,
    );
    const f = lastFrame() ?? '';
    expect(f).toContain('rm -rf /tmp/foo');
    expect(f).toContain('/work');
    expect(f).toContain('recursive delete');
  });
});
