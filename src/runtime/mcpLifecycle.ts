// src/runtime/mcpLifecycle.ts
//
// Sibling to workerLifecycle.ts.  Owns the lifecycle of MCP server child
// processes — one process per germinated MCP-spore, multiple processes alive
// concurrently per the multi-active model (§5.1.6).
//
// PID-access decision (T24): Option (b) — McpClient.getChildPid() exposes the
// PID via the SDK's public StdioClientTransport.pid getter.  This lets
// McpLifecycle do the SIGTERM → SIGKILL escalation pattern from workerLifecycle
// without reaching into private transport fields.
//
// R6 note: spawn() and initialize() are NOT routed through BullMQ — they're
// orchestrator-side lifecycle operations, not bash dispatch.  Subsequent
// client.callTool() calls are stdio JSON-RPC (single message in / out, no shell
// expansion).  callTimeoutMs protects against slow server I/O.  R6 intact.

import { join } from 'node:path';
import { createMcpClient } from '../mcp/McpClient.js';
import type { McpClient } from '../mcp/McpClient.js';
import type { Spore } from '../spores/Spore.js';
import type { Logger } from '../util/logger.js';

// ─── Public types ──────────────────────────────────────────────────────────────

export interface McpLifecycleOpts {
  /**
   * Directory for MCP server log files (mcp-<name>.log per server).
   *
   * Spec gap note: §5.5 doesn't list logsDir in McpLifecycleOpts, but log
   * routing to `.myceliate/logs/mcp-<server>.log` is spec'd in §5.1.3 and
   * §5.5's "wired into" bullet.  Kept REQUIRED so callers are explicit; the
   * bootTools path (T27) resolves this from ctx.memoryDir at construction time.
   */
  logsDir: string;
  /**
   * Timeout in ms for the MCP initialize handshake (§5.5).
   * Defaults from MCP_INITIALIZE_TIMEOUT_MS env var, then 5000.
   */
  initializeTimeoutMs?: number;
  /**
   * Default callTimeoutMs for all MCP clients spawned by this lifecycle.
   * Per-spore manifest.mcp_server.call_timeout_ms takes precedence (§5.2).
   * Defaults from MCP_CALL_TIMEOUT_MS env var, then 30000.
   */
  callTimeoutMs?: number;
  /**
   * Optional callback invoked when a managed MCP server exits unexpectedly
   * (i.e. not via teardown).  Receives the spore name and exit info.
   *
   * McpLifecycle bridges client.onUnexpectedExit() to this callback, then
   * removes the entry from the active map so subsequent getActive() returns
   * undefined and a fresh spawn() will start a new server.
   */
  onUnexpectedExit?: (
    sporeName: string,
    exitInfo: { code: number | null; signal: NodeJS.Signals | null },
  ) => void;
  /**
   * Grace period in ms between SIGTERM and SIGKILL escalation (§5.5).
   * Defaults from MCP_TEARDOWN_GRACE_MS env var, then 2000.
   */
  teardownGraceMs?: number;
  logger: Logger;
}

/** Entry stored in the active-spore map. */
interface ActiveEntry {
  client: McpClient;
  /** PID captured immediately after initialize() completes. */
  childPid: number | null;
  spawnedAt: number;
  /** True once teardown() has been called for this entry — suppresses the
   *  unexpected-exit handler so a clean shutdown doesn't trigger onUnexpectedExit. */
  teardownInitiated: boolean;
}

// ─── Error classes ─────────────────────────────────────────────────────────────

/** Thrown by spawn() when the spore's manifest lacks an mcp_server block. */
export class McpLifecycleSpawnError extends Error {
  constructor(sporeName: string) {
    super(
      `McpLifecycle.spawn(): spore "${sporeName}" has no mcp_server in its manifest. This is a caller bug — only MCP-spores should be passed to spawn().`,
    );
    this.name = 'McpLifecycleSpawnError';
  }
}

// ─── McpLifecycle class ────────────────────────────────────────────────────────

export class McpLifecycle {
  private readonly _opts: McpLifecycleOpts;
  private readonly _active = new Map<string, ActiveEntry>();
  private readonly _initializeTimeoutMs: number;
  private readonly _teardownGraceMs: number;
  private readonly _callTimeoutMs: number;

  constructor(opts: McpLifecycleOpts) {
    this._opts = opts;
    this._initializeTimeoutMs =
      opts.initializeTimeoutMs ?? (Number(process.env.MCP_INITIALIZE_TIMEOUT_MS) || 5000);
    this._teardownGraceMs =
      opts.teardownGraceMs ?? (Number(process.env.MCP_TEARDOWN_GRACE_MS) || 2000);
    this._callTimeoutMs = opts.callTimeoutMs ?? (Number(process.env.MCP_CALL_TIMEOUT_MS) || 30000);
  }

  /**
   * Spawn and initialize an MCP server for the given spore.
   *
   * Spec §5.5 seven-step spawn flow:
   * 1. Validate mcp_server is present.
   * 2. Idempotency — return existing client if already active.
   * 3. createMcpClient with per-spore callTimeoutMs override.
   * 4. client.initialize() with timeout guard.
   * 5. Register child-exit listener (bridges to onUnexpectedExit + map removal).
   * 6. Register entry in active map.
   * 7. Return client.
   */
  async spawn(spore: Spore): Promise<McpClient> {
    // Step 1: Validate.
    const mcpServer = spore.manifest.mcp_server;
    if (!mcpServer) {
      throw new McpLifecycleSpawnError(spore.name);
    }

    // Step 2: Idempotency — return existing client if this spore is already running.
    const existing = this._active.get(spore.name);
    if (existing) {
      return existing.client;
    }

    // Step 3: createMcpClient with per-spore callTimeoutMs override (§5.2).
    // Per-spore call_timeout_ms takes precedence over the lifecycle default.
    const callTimeoutMs = mcpServer.call_timeout_ms ?? this._callTimeoutMs;
    const logPath = join(this._opts.logsDir, `mcp-${spore.name}.log`);

    const client = createMcpClient({
      command: mcpServer.command,
      args: mcpServer.args,
      env: mcpServer.env,
      callTimeoutMs,
      initializeTimeoutMs: this._initializeTimeoutMs,
      serverName: spore.name,
      logPath,
      logger: this._opts.logger,
    });

    // Step 4: initialize() — McpClient already has a built-in timeout race via
    // initializeTimeoutMs.  We call it directly; on failure we propagate the error.
    try {
      await client.initialize();
    } catch (err) {
      await client.close().catch(() => {});
      throw err;
    }

    // Build the entry now (before registering the exit listener) so the handler
    // can read teardownInitiated without a race.
    const entry: ActiveEntry = {
      client,
      childPid: client.getChildPid(),
      spawnedAt: Date.now(),
      teardownInitiated: false,
    };

    // Step 5: Register child-exit listener.
    // The listener (a) invokes opts.onUnexpectedExit if set, (b) removes from map.
    // teardownInitiated guard prevents this from firing on explicit teardown().
    client.onUnexpectedExit((exitInfo) => {
      if (entry.teardownInitiated) {
        // Clean shutdown — do NOT invoke the unexpected-exit callback.
        return;
      }
      this._active.delete(spore.name);
      this._opts.logger.warn({
        msg: 'McpLifecycle: unexpected server exit',
        sporeName: spore.name,
        code: exitInfo.code,
        signal: exitInfo.signal,
      });
      this._opts.onUnexpectedExit?.(spore.name, exitInfo);
    });

    // Step 6: Register entry.
    this._active.set(spore.name, entry);

    // Step 7: Return client.
    return client;
  }

  /**
   * Tear down the MCP server for the named spore.
   *
   * Spec §5.5 teardown flow:
   * 1. client.close() — closes stdio transport; sets _closing flag so unexpected-exit
   *    handler does NOT fire (workerLifecycle pattern).
   * 2. SIGTERM the child (if PID is accessible).
   * 3. setTimeout(sigtermGraceMs) → SIGKILL if child has not exited.
   * 4. Deregister from map.
   *
   * No-op if the spore is not currently active.
   */
  async teardown(sporeName: string): Promise<void> {
    const entry = this._active.get(sporeName);
    if (!entry) return;

    // Mark teardown initiated BEFORE close() so the unexpected-exit bridge
    // can see the flag when the transport's onclose fires synchronously.
    entry.teardownInitiated = true;
    this._active.delete(sporeName);

    // Step 1: close() — sends stdin EOF + SIGTERM via SDK transport, waits up to
    // 2s for clean exit, then SIGKILL internally.  The SDK's close() already does a
    // SIGTERM → SIGKILL escalation.  We only do the additional escalation if the
    // PID is accessible and close() doesn't complete in time (belt + suspenders for
    // servers that ignore the SDK's escalation attempt).
    const { client, childPid } = entry;

    if (childPid !== null) {
      // Belt-and-suspenders escalation on top of the SDK's internal close() logic.
      // The SDK's close() does: stdin.end() → 2s → SIGTERM → 2s → SIGKILL.
      // Our escalation fires from outside via kill(pid) as an extra safety net for
      // servers that trap signals at the process-group level.
      const exitPromise = new Promise<void>((resolve) => {
        // We have no direct "child exited" event here — we rely on client.close()
        // completing as the signal that the child is done.
        void client.close().then(resolve, resolve);
      });

      const graceTimer = setTimeout(() => {
        try {
          process.kill(childPid, 'SIGTERM');
        } catch {
          // PID may already be gone — ignore ESRCH.
        }
        // Additional SIGKILL after the grace window.
        setTimeout(() => {
          try {
            process.kill(childPid, 'SIGKILL');
          } catch {
            // Already dead — ignore.
          }
        }, this._teardownGraceMs).unref();
      }, 100); // 100ms head-start for the SDK's own close() before our SIGTERM.
      graceTimer.unref();

      await exitPromise;
      clearTimeout(graceTimer);
    } else {
      // No PID accessible (child exited before initialize returned a PID — very rare).
      // Fall back to SDK's close() which handles its own SIGTERM/SIGKILL.
      await client.close().catch(() => {});
    }
  }

  /**
   * Tear down all active MCP servers in parallel.
   * Settle-all semantics: one teardown failure does not abort the rest.
   */
  async teardownAll(): Promise<void> {
    const names = [...this._active.keys()];
    await Promise.allSettled(names.map((name) => this.teardown(name)));
  }

  /** Returns the active McpClient for the named spore, or undefined if not active. */
  getActive(sporeName: string): McpClient | undefined {
    return this._active.get(sporeName)?.client;
  }

  /** Returns the names of all currently active spores. */
  listActive(): string[] {
    return [...this._active.keys()];
  }
}
