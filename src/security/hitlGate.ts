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

/**
 * The payload sent to the approval UI when a dangerous command is intercepted.
 *
 * T25 (v1.5 Phase 3 Exoenzyme): discriminated union — each check method
 * constructs the appropriate kind-tagged variant. The `kind` field lets
 * ApprovalPrompt.tsx type-narrow to the correct rendering branch without
 * unsafe field accesses.
 *
 * `requestId` — Cross-module ID used by the UI bridge to look up the right
 * resolver in a Map<requestId, fn>. Phase 17 m5 fix: src/index.ts maintains
 * a Map keyed by this ID so concurrent HITL requests no longer orphan the
 * first promise. The ID is the originating tool_call.id, threaded from
 * runReactLoop through ToolRunContext.toolUseId into bash.ts's checkBash call.
 */
export type ApprovalRequest =
  | { kind: 'bash'; requestId: string; command: string; cwd: string; reason: string }
  | { kind: 'write'; requestId: string; path: string; cwd: string; reason: string }
  | { kind: 'read'; requestId: string; path: string; reason: string }
  | {
      kind: 'mcp';
      requestId: string;
      server: string;
      tool: string;
      argsSummary: string;
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
 * Discriminated union result from any `HitlGate` check method (checkBash,
 * checkWrite, checkRead).
 *
 * - `{ allowed: true, requiredApproval: false }` — operation passed the static gate (no prompt).
 * - `{ allowed: true, requiredApproval: true }` — operation was risky but the user approved.
 * - `{ allowed: false, requiredApproval: true, feedback }` — user rejected; `feedback` is
 *   the rejection message (defaults to a generic string if the UI sent none).
 */
export type Verdict =
  | { allowed: true; requiredApproval: boolean }
  | { allowed: false; requiredApproval: true; feedback: string };

/**
 * HITL (Human-In-The-Loop) gate for orchestrator-initiated dangerous operations.
 *
 * Three check methods cover the v1.5 attack surface:
 * - `checkBash` (Phase 9): static dangerous-pattern blocklist for shell commands.
 * - `checkWrite` (v1.5 Cortina): cwd confinement for `write_file` dispatches.
 * - `checkRead` (v1.5 Cortina): sensitive-path gating for `read_file` dispatches.
 *
 * If the operation is safe, each method returns immediately. If it trips its
 * gate, the method AWAITS `requestApproval` before resolving — the calling
 * dispatch path blocks until the user explicitly approves or rejects.
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
      kind: 'bash',
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
   * R11 explicitly mandates HITL on "any write outside cwd". T25: the payload
   * now uses the `kind: 'write'` variant with a `path` field; the old
   * `command` sentinel is gone.
   */
  async checkWrite(input: WriteCheck): Promise<Verdict> {
    const resolvedPath = isAbsolute(input.path)
      ? resolve(input.path)
      : resolve(input.cwd, input.path);
    const resolvedCwd = resolve(input.cwd);
    const insideCwd = resolvedPath === resolvedCwd || resolvedPath.startsWith(resolvedCwd + sep);
    if (insideCwd) return { allowed: true, requiredApproval: false };

    const response = await this.opts.requestApproval({
      kind: 'write',
      requestId: input.requestId,
      path: resolvedPath,
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
   *
   * T25: uses `kind: 'read'` with `path` field; no `cwd` sentinel needed
   * since the discriminated union's read variant omits cwd entirely.
   */
  async checkRead(input: ReadCheck): Promise<Verdict> {
    const resolvedPath = resolve(input.path);
    const sensitive = SENSITIVE_READ_PATTERNS.find((p) => p.re.test(resolvedPath));
    if (!sensitive) return { allowed: true, requiredApproval: false };

    const response = await this.opts.requestApproval({
      kind: 'read',
      requestId: input.requestId,
      path: resolvedPath,
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

  /**
   * v1.5 Phase 3 Exoenzyme (T25): gate MCP tool dispatches.
   *
   * No static gate — the sensitivity decision was already made by
   * `germinate_spore` (§5.7) when the wrapper was registered. `checkMcp`
   * ALWAYS prompts regardless of the tool name. The `(server, tool)` tuple
   * is the unique audit identity; `argsSummary` is informational.
   *
   * Unlike `checkBash`, there is no `isDangerous` pre-filter here — the
   * caller (germinate_spore) is responsible for deciding which MCP tools
   * require HITL; once routed here the user must always approve.
   */
  async checkMcp(input: {
    requestId: string;
    server: string;
    tool: string;
    argsSummary: string;
    reason: string;
  }): Promise<Verdict> {
    const response = await this.opts.requestApproval({
      kind: 'mcp',
      requestId: input.requestId,
      server: input.server,
      tool: input.tool,
      argsSummary: input.argsSummary,
      reason: input.reason,
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
