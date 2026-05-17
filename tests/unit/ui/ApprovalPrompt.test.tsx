import { render } from 'ink-testing-library';
import React from 'react';
// tests/unit/ui/ApprovalPrompt.test.tsx
import { describe, expect, it, vi } from 'vitest';
import { ApprovalPrompt } from '../../../src/ui/ApprovalPrompt.js';

describe('ApprovalPrompt', () => {
  it('renders bash request — Command and Cwd fields', () => {
    const { lastFrame } = render(
      <ApprovalPrompt
        request={{
          kind: 'bash',
          requestId: 'r1',
          command: 'rm -rf /tmp/foo',
          cwd: '/work',
          reason: 'recursive delete',
        }}
        onResponse={() => {}}
      />,
    );
    const f = lastFrame() ?? '';
    expect(f).toContain('rm -rf /tmp/foo');
    expect(f).toContain('/work');
    expect(f).toContain('recursive delete');
  });

  it('renders write request — Write to and Cwd fields', () => {
    const { lastFrame } = render(
      <ApprovalPrompt
        request={{
          kind: 'write',
          requestId: 'r2',
          path: '/etc/hosts',
          cwd: '/tmp',
          reason: 'write outside cwd',
        }}
        onResponse={() => {}}
      />,
    );
    const f = lastFrame() ?? '';
    expect(f).toContain('/etc/hosts');
    expect(f).toContain('/tmp');
    expect(f).toContain('write outside cwd');
  });

  it('renders read request — Read field', () => {
    const { lastFrame } = render(
      <ApprovalPrompt
        request={{
          kind: 'read',
          requestId: 'r3',
          path: '/home/patty/.ssh/id_rsa',
          reason: 'read sensitive path: SSH config / private keys directory',
        }}
        onResponse={() => {}}
      />,
    );
    const f = lastFrame() ?? '';
    expect(f).toContain('/home/patty/.ssh/id_rsa');
    expect(f).toContain('read sensitive path');
  });

  it('renders mcp request — Server, Tool and Args fields', () => {
    const { lastFrame } = render(
      <ApprovalPrompt
        request={{
          kind: 'mcp',
          requestId: 'r4',
          server: 'playwright',
          tool: 'navigate',
          argsSummary: '{ url: "https://example.com" }',
          reason: 'MCP tool call',
        }}
        onResponse={() => {}}
      />,
    );
    const f = lastFrame() ?? '';
    expect(f).toContain('playwright');
    expect(f).toContain('navigate');
    expect(f).toContain('https://example.com');
    expect(f).toContain('MCP tool call');
  });

  it('fires onResponse exactly once even on rapid repeated keypresses', async () => {
    const onResponse = vi.fn();
    const { stdin } = render(
      <ApprovalPrompt
        request={{
          kind: 'bash',
          requestId: 'r5',
          command: 'rm -rf /tmp/foo',
          cwd: '/work',
          reason: 'recursive delete',
        }}
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
