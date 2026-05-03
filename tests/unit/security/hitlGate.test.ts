// tests/unit/security/hitlGate.test.ts
import { describe, expect, it, vi } from 'vitest';
import { HitlGate } from '../../../src/security/hitlGate.js';

describe('HitlGate', () => {
  // --- Plan-specified tests ---

  it('passes through commands deemed safe by isDangerous', async () => {
    const gate = new HitlGate({ requestApproval: vi.fn() });
    const verdict = await gate.checkBash({ command: 'ls -la', cwd: process.cwd() });
    expect(verdict.allowed).toBe(true);
    expect(verdict.requiredApproval).toBe(false);
  });

  it('routes dangerous commands to requestApproval and respects approve', async () => {
    const requestApproval = vi.fn().mockResolvedValue({ decision: 'approve' });
    const gate = new HitlGate({ requestApproval });
    const verdict = await gate.checkBash({ command: 'rm -rf /tmp/foo/', cwd: process.cwd() });
    expect(verdict.allowed).toBe(true);
    expect(verdict.requiredApproval).toBe(true);
    expect(requestApproval).toHaveBeenCalled();
  });

  it('blocks when user rejects', async () => {
    const requestApproval = vi
      .fn()
      .mockResolvedValue({ decision: 'reject', feedback: 'too broad' });
    const gate = new HitlGate({ requestApproval });
    const verdict = await gate.checkBash({ command: 'sudo rm -rf ~', cwd: process.cwd() });
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
    const checkPromise = gate.checkBash({ command: 'rm -rf /', cwd: process.cwd() }).then((v) => {
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

  it('requestApproval is called with command, cwd, and reason fields', async () => {
    const requestApproval = vi.fn().mockResolvedValue({ decision: 'approve' });
    const gate = new HitlGate({ requestApproval });
    const cwd = process.cwd();
    await gate.checkBash({ command: 'sudo apt-get install vim', cwd });
    expect(requestApproval).toHaveBeenCalledWith({
      command: 'sudo apt-get install vim',
      cwd,
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
    const verdict = await gate.checkBash({ command: 'rm -rf /', cwd: process.cwd() });
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
    const verdict = await gate.checkBash({ command: 'sudo rm -rf ~', cwd: process.cwd() });
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(typeof verdict.feedback).toBe('string');
      expect(verdict.feedback.length).toBeGreaterThan(0);
    }
  });

  it('safe commands never call requestApproval', async () => {
    const requestApproval = vi.fn();
    const gate = new HitlGate({ requestApproval });
    await gate.checkBash({ command: 'echo hello', cwd: process.cwd() });
    expect(requestApproval).not.toHaveBeenCalled();
  });
});
