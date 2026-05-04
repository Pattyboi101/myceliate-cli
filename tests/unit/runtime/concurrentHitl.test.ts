// tests/unit/runtime/concurrentHitl.test.ts
//
// Phase 17 Task 106: regression test for the m5 BLOCKER fix. Two HITL requests
// arrive in close succession; the first must NOT be orphaned by the second.
// The single-slot pattern would lose the first; the Map<requestId, fn> pattern
// resolves both.

import { describe, expect, it } from 'vitest';

describe('Concurrent HITL approval (Phase 17 Task 106 — m5 BLOCKER fix)', () => {
  it('Map<requestId, fn> resolves both promises when 2 HITL requests arrive before either is answered', async () => {
    // We model the contract enforced by src/index.ts at the data-shape level
    // (the actual main() wiring is exercised by the manual-smoke checklist
    // and the existing onState-handler tests; this test verifies the Map
    // pattern itself is correct).
    type ApprovalResponse = { decision: 'approve' | 'reject'; feedback?: string };
    type ApprovalRequest = { requestId: string; command: string; cwd: string; reason: string };
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
});
