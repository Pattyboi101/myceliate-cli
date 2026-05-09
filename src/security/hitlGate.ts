// src/security/hitlGate.ts
import { isAbsolute, resolve, sep } from 'node:path';
import { isDangerous } from './dangerousPatterns.js';

/**
 * v1.5 Cortina: paths considered sensitive enough to require HITL approval before
 * the file tools may read them. Matched against the resolved absolute path.
 *
 * The list errs on the side of false positives — a benign read of `~/.bashrc`
 * during a legit task is annoying; a silent leak of `~/.aws/credentials` is
 * a security incident. The user can approve-once for legitimate reads.
 *
 * v2: extend with corporate-creds patterns (cloud SDK caches, IDE settings),
 * symlink-resolution, and per-Spore allowlist overrides.
 */
const SENSITIVE_READ_PATTERNS: { re: RegExp; reason: string }[] = [
  { re: /(?:^|\/)\.ssh(?:\/|$)/, reason: 'SSH config / private keys directory' },
  { re: /(?:^|\/)\.aws(?:\/|$)/, reason: 'AWS credentials directory' },
  { re: /(?:^|\/)\.config\/gcloud(?:\/|$)/, reason: 'GCP credentials directory' },
  { re: /(?:^|\/)\.kube\/config$/, reason: 'Kubernetes cluster credentials' },
  { re: /(?:^|\/)\.docker\/config\.json$/, reason: 'Docker registry credentials' },
  { re: /(?:^|\/)\.gnupg(?:\/|$)/, reason: 'GPG keyring' },
  { re: /(?:^|\/)\.netrc$/, reason: 'generic .netrc credentials' },
  { re: /(?:^|\/)\.npmrc$/, reason: 'npm registry tokens' },
  { re: /(?:^|\/)\.pypirc$/, reason: 'PyPI tokens' },
  { re: /(?:^|\/)\.(?:bashrc|zshrc|profile|bash_profile|zprofile)$/, reason: 'shell startup file' },
  { re: /^\/etc\/(?:passwd|shadow|sudoers)/, reason: 'system account / sudo config' },
  { re: /^\/proc\/self\/environ$/, reason: 'process environment (often leaks credentials)' },
];

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

/** Input shape for `HitlGate.checkWrite` (v1.5 Cortina). */
export type WriteCheck = { path: string; cwd: string; requestId: string };

/** Input shape for `HitlGate.checkRead` (v1.5 Cortina). */
export type ReadCheck = { path: string; requestId: string };

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

  /**
   * v1.5 Cortina: gate write_file dispatches.
   *
   * Allowed when the resolved write path stays inside the orchestrator's cwd.
   * Otherwise the user is prompted to approve / reject — preventing prompt-
   * injected writes to ~/.ssh/authorized_keys, ~/.bashrc, /etc/..., etc.
   *
   * R11 explicitly mandates HITL on "any write outside cwd". The approval
   * payload reuses the bash-shaped ApprovalRequest with the `command` field
   * carrying a "write_file → <path>" description; the UI ApprovalPrompt
   * already renders this as a labelled approval. v2 may introduce a
   * discriminated ApprovalRequest union with dedicated `kind: 'write'`
   * rendering, but that is UI work outside Cortina's scope.
   */
  async checkWrite(input: WriteCheck): Promise<Verdict> {
    const resolvedPath = isAbsolute(input.path)
      ? resolve(input.path)
      : resolve(input.cwd, input.path);
    const resolvedCwd = resolve(input.cwd);
    const insideCwd = resolvedPath === resolvedCwd || resolvedPath.startsWith(resolvedCwd + sep);
    if (insideCwd) return { allowed: true, requiredApproval: false };

    const response = await this.opts.requestApproval({
      requestId: input.requestId,
      command: `write_file → ${resolvedPath}`,
      cwd: resolvedCwd,
      reason: `write outside cwd (${resolvedCwd})`,
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

  /**
   * v1.5 Cortina: gate read_file dispatches that target a sensitive path.
   *
   * Match against SENSITIVE_READ_PATTERNS (SSH/AWS/GCP/k8s/GPG/.netrc/shell
   * startup/system accounts/process env). Hit → require user approval.
   * Non-match → allowed silently. The asymmetry vs checkWrite is deliberate:
   * blanket-gating every read would prompt-storm the user during normal code
   * exploration, while writes to anywhere outside cwd are inherently rare and
   * worth gating universally.
   */
  async checkRead(input: ReadCheck): Promise<Verdict> {
    const resolvedPath = resolve(input.path);
    const sensitive = SENSITIVE_READ_PATTERNS.find((p) => p.re.test(resolvedPath));
    if (!sensitive) return { allowed: true, requiredApproval: false };

    const response = await this.opts.requestApproval({
      requestId: input.requestId,
      command: `read_file → ${resolvedPath}`,
      cwd: resolvedPath, // no separate cwd concept for reads; reuse the field
      reason: `read sensitive path: ${sensitive.reason}`,
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
