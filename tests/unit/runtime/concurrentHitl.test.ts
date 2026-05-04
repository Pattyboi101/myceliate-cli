// tests/unit/runtime/concurrentHitl.test.ts
//
// Phase 17 Task 106: regression test for the m5 BLOCKER fix. Two HITL requests
// arrive in close succession; the first must NOT be orphaned by the second.
// The single-slot pattern would lose the first; the Map<requestId, fn> pattern
// resolves both.
//
// Phase 17 review m3-related: this test is INTENTIONALLY a self-contained
// data-shape model. The local `pending.push`/`pending.shift` mutations differ
// from production's immutable `[...pendingApprovals, req]` / `pending.slice(1)`
// pattern (which is required for React rerender correctness — a fresh array
// reference signals state change). The contract being verified is the
// ordering + Map.set/get/delete sequence, NOT the array allocation strategy.
// Do not "harmonise" the test with production by switching to slice; do not
// regress production to push/shift.

import { describe, expect, it } from 'vitest';

describe('Concurrent HITL approval (Phase 17 Task 106 — m5 BLOCKER fix)', () => {
  // Shared types for both tests below — identical to production's
  // ApprovalRequest/ApprovalResponse shape from src/security/hitlGate.ts.
  type ApprovalResponse = { decision: 'approve' | 'reject'; feedback?: string };
  type ApprovalRequest = { requestId: string; command: string; cwd: string; reason: string };

  it('Map<requestId, fn> resolves both promises when 2 HITL requests arrive before either is answered', async () => {
    // We model the contract enforced by src/index.ts at the data-shape level
    // (the actual main() wiring is exercised by the manual-smoke checklist
    // and the existing onState-handler tests; this test verifies the Map
    // pattern itself is correct).
    const resolvers = new Map<string, (r: ApprovalResponse) => void>();
    const pending: ApprovalRequest[] = [];

    function requestApproval(req: ApprovalRequest): Promise<ApprovalResponse> {
      return new Promise((resolve) => {
        resolvers.set(req.requestId, resolve);
        pending.push(req);
      });
    }

    function onApprovalResponse(response: ApprovalResponse): void {
      const head = pending[0];
      if (!head) return;
      const fn = resolvers.get(head.requestId);
      if (!fn) return;
      pending.shift();
      resolvers.delete(head.requestId);
      fn(response);
    }

    // Two requests fire concurrently — neither is resolved yet.
    const p1 = requestApproval({ requestId: 'r1', command: 'a', cwd: '/', reason: 'x' });
    const p2 = requestApproval({ requestId: 'r2', command: 'b', cwd: '/', reason: 'y' });
    expect(resolvers.size).toBe(2);
    expect(pending.length).toBe(2);

    // User answers the head (r1) first.
    onApprovalResponse({ decision: 'approve' });
    const v1 = await p1;
    expect(v1.decision).toBe('approve');
    // Phase 17 review m1: assert BOTH map and queue mid-state. Without the
    // pending.length assertion, a regression that double-shifted (or otherwise
    // emptied the queue past the intended single removal) would slip past the
    // size==1 / has('r2')==true checks below.
    expect(pending.length).toBe(1);
    expect(resolvers.size).toBe(1);
    expect(resolvers.has('r1')).toBe(false);
    expect(resolvers.has('r2')).toBe(true);

    // Then answers r2.
    onApprovalResponse({ decision: 'reject', feedback: 'no' });
    const v2 = await p2;
    expect(v2.decision).toBe('reject');
    expect(v2.feedback).toBe('no');
    expect(resolvers.size).toBe(0);
    expect(pending.length).toBe(0);
  });

  // Phase 17 review (both reviewers' coverage gaps): lock the empty-queue
  // double-fire guard explicitly. If `onApprovalResponse` fires when the
  // queue is empty (e.g., user double-clicks Y after the prompt closes,
  // or fires after a race between rerender + keypress), the early-return
  // on `!head` must hold — no Map lookup, no resolver call, no exception.
  it('onApprovalResponse on an empty queue is a no-op (does NOT throw or mutate state)', () => {
    const resolvers = new Map<string, (r: ApprovalResponse) => void>();
    const pending: ApprovalRequest[] = [];

    function onApprovalResponse(response: ApprovalResponse): void {
      const head = pending[0];
      if (!head) return;
      const fn = resolvers.get(head.requestId);
      if (!fn) return;
      pending.shift();
      resolvers.delete(head.requestId);
      fn(response);
    }

    // No throw, no mutation — just an early return.
    expect(() => onApprovalResponse({ decision: 'approve' })).not.toThrow();
    expect(pending.length).toBe(0);
    expect(resolvers.size).toBe(0);
  });
});
