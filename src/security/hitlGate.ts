// src/security/hitlGate.ts
import { isDangerous } from './dangerousPatterns.js';

/** The payload sent to the approval UI when a dangerous command is intercepted. */
export type ApprovalRequest = {
  /** Cross-module ID used by the UI bridge to look up the right resolver in
   * a Map<requestId, fn>. Phase 17 m5 fix: src/index.ts maintains a Map
   * keyed by this ID so concurrent HITL requests no longer orphan the first
   * promise. The ID is the originating tool_call.id, threaded from
   * runReactLoop through ToolRunContext.toolUseId into bash.ts's checkBash
   * call. */
  requestId: string;
  command: string;
  cwd: string;
  reason: string;
};

/**
 * The response from the approval UI.
 * `feedback` is optional — callers may omit it entirely for a plain approve/reject.
 */
export type ApprovalResponse = { decision: 'approve' | 'reject'; feedback?: string };

/** Signature of the callback that suspends execution until the user decides. */
export type ApprovalRequester = (req: ApprovalRequest) => Promise<ApprovalResponse>;

/** Input shape for `HitlGate.checkBash`. */
export type BashCheck = { command: string; cwd: string; requestId: string };

/**
 * Discriminated union result from `HitlGate.checkBash`.
 *
 * - `{ allowed: true, requiredApproval: false }` — command passed the static blocklist.
 * - `{ allowed: true, requiredApproval: true }` — command was dangerous but the user approved.
 * - `{ allowed: false, requiredApproval: true, feedback }` — user rejected; `feedback` is
 *   the rejection message (defaults to a generic string if the UI sent none).
 */
export type Verdict =
  | { allowed: true; requiredApproval: boolean }
  | { allowed: false; requiredApproval: true; feedback: string };

/**
 * HITL (Human-In-The-Loop) gate for bash command dispatch.
 *
 * Orchestrator (Phase 9) calls `checkBash` ahead of every bash dispatch.
 * If the command is safe, the method returns immediately. If it trips the
 * static blocklist, the method AWAITS `requestApproval` before resolving —
 * the calling dispatch path blocks until the user explicitly approves or rejects.
 *
 * This is intentional: execution must not proceed until the user says yes (R11).
 */
export class HitlGate {
  constructor(private readonly opts: { requestApproval: ApprovalRequester }) {}

  async checkBash(input: BashCheck): Promise<Verdict> {
    const v = isDangerous(input.command);
    if (!v.dangerous) return { allowed: true, requiredApproval: false };

    // Await the user's decision — this is the suspension point.
    const response = await this.opts.requestApproval({
      requestId: input.requestId,
      command: input.command,
      cwd: input.cwd,
      reason: v.reason,
    });

    if (response.decision === 'approve') {
      return { allowed: true, requiredApproval: true };
    }
    return {
      allowed: false,
      requiredApproval: true,
      feedback: response.feedback ?? 'rejected without feedback',
    };
  }
}
