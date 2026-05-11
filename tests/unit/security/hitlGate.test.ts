// tests/unit/security/hitlGate.test.ts
import { describe, expect, it, vi } from 'vitest';
import {
  type ApprovalRequest,
  type ApprovalRequester,
  HitlGate,
} from '../../../src/security/hitlGate.js';

describe('HitlGate', () => {
  // --- Plan-specified tests ---

  it('passes through commands deemed safe by isDangerous', async () => {
    const gate = new HitlGate({ requestApproval: vi.fn() });
    const verdict = await gate.checkBash({
      command: 'ls -la',
      cwd: process.cwd(),
      requestId: 'test-id',
    });
    expect(verdict.allowed).toBe(true);
    expect(verdict.requiredApproval).toBe(false);
  });

  it('routes dangerous commands to requestApproval and respects approve', async () => {
    const requestApproval = vi.fn().mockResolvedValue({ decision: 'approve' });
    const gate = new HitlGate({ requestApproval });
    const verdict = await gate.checkBash({
      command: 'rm -rf /tmp/foo/',
      cwd: process.cwd(),
      requestId: 'test-id',
    });
    expect(verdict.allowed).toBe(true);
    expect(verdict.requiredApproval).toBe(true);
    expect(requestApproval).toHaveBeenCalled();
  });

  it('blocks when user rejects', async () => {
    const requestApproval = vi
      .fn()
      .mockResolvedValue({ decision: 'reject', feedback: 'too broad' });
    const gate = new HitlGate({ requestApproval });
    const verdict = await gate.checkBash({
      command: 'sudo rm -rf ~',
      cwd: process.cwd(),
      requestId: 'test-id',
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.feedback).toBe('too broad');
  });

  // --- Additional contract tests ---

  it('requestApproval is awaited — gate does not resolve before approval resolves', async () => {
    let resolveApproval!: (r: { decision: 'approve' }) => void;
    const approvalPromise = new Promise<{ decision: 'approve' }>((res) => {
      resolveApproval = res;
    });
    const requestApproval = vi.fn().mockReturnValue(approvalPromise);
    const gate = new HitlGate({ requestApproval });

    let settled = false;
    const checkPromise = gate
      .checkBash({ command: 'rm -rf /', cwd: process.cwd(), requestId: 'test-id' })
      .then((v) => {
        settled = true;
        return v;
      });

    // Let the microtask queue drain — checkBash has called requestApproval,
    // but approvalPromise has not yet resolved.
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    // Now unblock the approval.
    resolveApproval({ decision: 'approve' });
    const verdict = await checkPromise;
    expect(settled).toBe(true);
    expect(verdict.allowed).toBe(true);
    expect(verdict.requiredApproval).toBe(true);
  });

  it('requestApproval is called with kind:bash, command, cwd, requestId, and reason fields', async () => {
    const requestApproval = vi.fn().mockResolvedValue({ decision: 'approve' });
    const gate = new HitlGate({ requestApproval });
    const cwd = process.cwd();
    await gate.checkBash({ command: 'sudo apt-get install vim', cwd, requestId: 'test-id' });
    expect(requestApproval).toHaveBeenCalledWith({
      kind: 'bash',
      command: 'sudo apt-get install vim',
      cwd,
      requestId: 'test-id',
      reason: expect.any(String),
    });
  });

  it('approve with feedback — allowed=true, requiredApproval=true; feedback not propagated on approve', async () => {
    // The `feedback` field only lives on the { allowed: false } arm of Verdict.
    // An approved response should yield allowed:true even if the approval response
    // happened to carry a feedback string (informational notes from the UI).
    const requestApproval = vi
      .fn()
      .mockResolvedValue({ decision: 'approve', feedback: 'looks okay' });
    const gate = new HitlGate({ requestApproval });
    const verdict = await gate.checkBash({
      command: 'rm -rf /',
      cwd: process.cwd(),
      requestId: 'test-id',
    });
    expect(verdict.allowed).toBe(true);
    expect(verdict.requiredApproval).toBe(true);
    // TypeScript discriminated union: `feedback` is only present on the false arm.
    // Accessing it here would be a type error; we just confirm the shape.
    if (!verdict.allowed) {
      // This branch should not be reached; the assertion below ensures it isn't.
      expect(verdict.allowed).toBe(true); // fail-safe
    }
  });

  it('reject without feedback falls back to default message', async () => {
    // When the approval response has no feedback field, the gate provides a default.
    const requestApproval = vi.fn().mockResolvedValue({ decision: 'reject' });
    const gate = new HitlGate({ requestApproval });
    const verdict = await gate.checkBash({
      command: 'sudo rm -rf ~',
      cwd: process.cwd(),
      requestId: 'test-id',
    });
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(typeof verdict.feedback).toBe('string');
      expect(verdict.feedback.length).toBeGreaterThan(0);
    }
  });

  it('safe commands never call requestApproval', async () => {
    const requestApproval = vi.fn();
    const gate = new HitlGate({ requestApproval });
    await gate.checkBash({ command: 'echo hello', cwd: process.cwd(), requestId: 'test-id' });
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('propagates requestApproval rejection (UI throws — error surfaces to caller)', async () => {
    // Contract: the gate is a thin wrapper. If the approval UI errors, the rejection
    // should bubble to the orchestrator rather than being swallowed into a silent verdict.
    const requestApproval = vi.fn().mockRejectedValue(new Error('UI crashed'));
    const gate = new HitlGate({ requestApproval });
    await expect(
      gate.checkBash({ command: 'rm -rf /', cwd: process.cwd(), requestId: 'test-id' }),
    ).rejects.toThrow('UI crashed');
  });

  it('threads requestId through ApprovalRequest and exposes it to the requestApproval callback', async () => {
    let observedRequestId: string | undefined;
    const hitl = new HitlGate({
      requestApproval: async (req) => {
        observedRequestId = req.requestId;
        return { decision: 'reject', feedback: 'no' };
      },
    });
    const verdict = await hitl.checkBash({
      command: 'rm -rf /',
      cwd: '/tmp',
      requestId: 'tool-call-abc-123',
    });
    expect(observedRequestId).toBe('tool-call-abc-123');
    expect(verdict.allowed).toBe(false);
  });

  // --- Discriminated union kind tests (T25) ---

  it('checkBash passes kind:"bash" in the ApprovalRequest', async () => {
    let observedKind: string | undefined;
    const hitl = new HitlGate({
      requestApproval: async (req) => {
        observedKind = req.kind;
        return { decision: 'approve' };
      },
    });
    await hitl.checkBash({ command: 'rm -rf /', cwd: '/tmp', requestId: 'r1' });
    expect(observedKind).toBe('bash');
  });

  it('checkWrite passes kind:"write" and path field (not command) in the ApprovalRequest', async () => {
    let observedReq: ApprovalRequest | undefined;
    const requestApproval: ApprovalRequester = async (req) => {
      observedReq = req;
      return { decision: 'approve' };
    };
    const hitl = new HitlGate({ requestApproval });
    await hitl.checkWrite({ path: '/etc/shadow', cwd: '/tmp', requestId: 'r2' });
    expect(observedReq?.kind).toBe('write');
    if (observedReq && observedReq.kind === 'write') {
      expect(observedReq.path).toBe('/etc/shadow');
    }
  });

  it('checkRead passes kind:"read" and path field in the ApprovalRequest', async () => {
    let observedReq: ApprovalRequest | undefined;
    const requestApproval: ApprovalRequester = async (req) => {
      observedReq = req;
      return { decision: 'approve' };
    };
    const hitl = new HitlGate({ requestApproval });
    await hitl.checkRead({ path: '/home/patty/.ssh/id_rsa', requestId: 'r3' });
    expect(observedReq?.kind).toBe('read');
    if (observedReq && observedReq.kind === 'read') {
      expect(observedReq.path).toBe('/home/patty/.ssh/id_rsa');
    }
  });

  it('checkMcp with approving requester returns { allowed: true, requiredApproval: true }', async () => {
    const requestApproval = vi.fn().mockResolvedValue({ decision: 'approve' });
    const gate = new HitlGate({ requestApproval });
    const verdict = await gate.checkMcp({
      requestId: 'mcp-r1',
      server: 'playwright',
      tool: 'navigate',
      argsSummary: '{ url: "https://example.com" }',
      reason: 'MCP tool call',
    });
    expect(verdict.allowed).toBe(true);
    expect(verdict.requiredApproval).toBe(true);
    expect(requestApproval).toHaveBeenCalled();
  });

  it('checkMcp with rejecting requester returns { allowed: false, requiredApproval: true, feedback }', async () => {
    const requestApproval = vi
      .fn()
      .mockResolvedValue({ decision: 'reject', feedback: 'not allowed' });
    const gate = new HitlGate({ requestApproval });
    const verdict = await gate.checkMcp({
      requestId: 'mcp-r2',
      server: 'playwright',
      tool: 'click',
      argsSummary: '{ selector: "#btn" }',
      reason: 'MCP tool call',
    });
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.requiredApproval).toBe(true);
      expect(verdict.feedback).toBe('not allowed');
    }
  });

  it('checkMcp always prompts — no static gate (always calls requestApproval)', async () => {
    const requestApproval = vi.fn().mockResolvedValue({ decision: 'approve' });
    const gate = new HitlGate({ requestApproval });
    await gate.checkMcp({
      requestId: 'mcp-r3',
      server: 'some-server',
      tool: 'safe_tool',
      argsSummary: '{}',
      reason: 'MCP tool call',
    });
    // Unlike checkBash which has a static gate, checkMcp always prompts.
    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('checkMcp passes kind:"mcp" with server, tool, argsSummary fields', async () => {
    let observedReq: unknown;
    const hitl = new HitlGate({
      requestApproval: async (req) => {
        observedReq = req;
        return { decision: 'approve' };
      },
    });
    await hitl.checkMcp({
      requestId: 'mcp-r4',
      server: 'playwright',
      tool: 'navigate',
      argsSummary: '{ url: "https://example.com" }',
      reason: 'sensitive MCP call',
    });
    expect(observedReq).toMatchObject({
      kind: 'mcp',
      requestId: 'mcp-r4',
      server: 'playwright',
      tool: 'navigate',
      argsSummary: '{ url: "https://example.com" }',
      reason: 'sensitive MCP call',
    });
  });
});
