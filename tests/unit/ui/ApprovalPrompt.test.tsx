import { render } from 'ink-testing-library';
import React from 'react';
// tests/unit/ui/ApprovalPrompt.test.tsx
import { describe, expect, it, vi } from 'vitest';
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

  it('fires onResponse exactly once even on rapid repeated keypresses', async () => {
    const onResponse = vi.fn();
    const { stdin } = render(
      <ApprovalPrompt
        request={{ command: 'rm -rf /tmp/foo', cwd: '/work', reason: 'recursive delete' }}
        onResponse={onResponse}
      />,
    );
    // Wait for Ink's useEffect to register the 'readable' listener via setRawMode.
    await new Promise((r) => setTimeout(r, 50));
    stdin.write('y');
    stdin.write('y');
    stdin.write('n');
    await new Promise((r) => setTimeout(r, 50));
    expect(onResponse).toHaveBeenCalledTimes(1);
    expect(onResponse).toHaveBeenCalledWith({ decision: 'approve' });
  });
});
