// src/mcp/McpClient.ts
//
// Thin wrapper over @modelcontextprotocol/sdk/client exposing the subset of
// MCP we use.  A stable internal interface so SDK version churn doesn't bleed
// through.  Also provides the RecordingMcpClient test-seam (T30) and the
// single-chokepoint property (§5.1.5).
//
// R1 analogue: we do NOT translate JSON-RPC into a "canonical event"
// intermediate.  SDK response types pass through as-is.  Adding a second
// transport (HTTP, future MCP revisions) means adding another factory;
// nothing else changes.
//
// STDIO HYGIENE CAVEAT: Some misbehaving MCP servers write debug output to
// stdout instead of stderr, which corrupts the JSON-RPC framing that
// StdioClientTransport parses.  This is a known SDK gotcha.  Child stderr is
// routed to opts.logPath (defaults to suppressed) for forensic inspection when
// an MCP integration breaks unexpectedly.  If a particular server proves
// chronically dirty, a v1.6 ride-along could add a stdout-sniffer that detects
// non-JSON-prefix lines and routes them to a log file instead of breaking the
// stream.

import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Logger } from '../util/logger.js';

// ─── Public types ──────────────────────────────────────────────────────────────

export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // raw JSON Schema from server (consumed unchanged by ToolRegistry per §5.7)
}

export interface McpToolResult {
  content: Array<
    { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
  >;
  isError: boolean;
}

export interface McpClient {
  initialize(): Promise<void>;
  listTools(): Promise<McpToolDescriptor[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult>;
  close(): Promise<void>;
  /** Phase 3 crash-detection: true once the underlying child has exited unexpectedly.
   *  Subsequent callTool invocations reject immediately rather than awaiting a dead
   *  transport. NOTE: a callTimeoutMs timeout does NOT set faulted state — timed-out
   *  calls are recoverable (the model can retry or change tactic). */
  isFaulted(): boolean;
  /** Phase 3: register a one-shot listener fired when the child exits unexpectedly.
   *  McpLifecycle bridges this to ToolRegistry deregistration + a system-message emit. */
  onUnexpectedExit(
    handler: (info: { code: number | null; signal: NodeJS.Signals | null }) => void,
  ): void;
  /**
   * Phase 3 (McpLifecycle): returns the PID of the underlying child process, or
   * null if the transport has not been started yet or the child has already exited.
   *
   * The SDK's StdioClientTransport exposes `get pid()` as a public API — this is
   * NOT an escape-hatch into internals.  McpLifecycle uses the PID for the
   * SIGTERM → SIGKILL escalation pattern that mirrors workerLifecycle.ts.
   *
   * PID-access decision (T24): Option (b) — expose via McpClient interface rather
   * than (a) spawning our own child, (c) relying solely on transport.close(), or
   * (d) poking a private `_process` field.
   */
  getChildPid(): number | null;
}

export class McpServerCrashedError extends Error {
  constructor(
    public readonly server: string,
    public readonly exitInfo: { code: number | null; signal: NodeJS.Signals | null },
    override readonly cause?: unknown,
  ) {
    super(
      `MCP server "${server}" exited unexpectedly (code=${exitInfo.code}, signal=${exitInfo.signal})`,
    );
    this.name = 'McpServerCrashedError';
  }
}

export class McpToolTimeoutError extends Error {
  constructor(
    public readonly server: string,
    public readonly tool: string,
    public readonly timeoutMs: number,
  ) {
    super(
      `MCP tool "${server}.${tool}" exceeded callTimeoutMs (${timeoutMs}ms) — call abandoned, server may still be working`,
    );
    this.name = 'McpToolTimeoutError';
  }
}

export interface McpClientOpts {
  command: string;
  args: string[];
  env: Record<string, string>;
  initializeTimeoutMs?: number; // default 30000 (env: MCP_INITIALIZE_TIMEOUT_MS)
  callTimeoutMs?: number; // default 30000 (env: MCP_CALL_TIMEOUT_MS) — Promise.race in callTool guards the ReAct loop from hanging server I/O
  /** Optional name used in error messages; defaults to basename of command. */
  serverName?: string;
  /** Optional path to route child stderr output to (.myceliate/logs/mcp-<server>.log).
   *  If absent, child stderr is inherited (visible in parent stderr).
   *  Fails gracefully if the path cannot be created/written. */
  logPath?: string;
  logger: Logger;
}

// ─── Factory ───────────────────────────────────────────────────────────────────

export function createMcpClient(opts: McpClientOpts): McpClient {
  return new McpClientImpl(opts);
}

// ─── Implementation ────────────────────────────────────────────────────────────

class McpClientImpl implements McpClient {
  private readonly _serverName: string;
  private readonly _initTimeoutMs: number;
  private readonly _callTimeoutMs: number;
  private readonly _logger: Logger;

  // SDK objects — set during initialize()
  private _sdkClient: Client | null = null;
  private _transport: StdioClientTransport | null = null;

  // Faulted-state tracking
  private _faulted = false;
  private _closing = false;
  private _unexpectedExitHandler:
    | ((info: { code: number | null; signal: NodeJS.Signals | null }) => void)
    | null = null;
  private _unexpectedExitFired = false;
  private _lastExitInfo: { code: number | null; signal: NodeJS.Signals | null } = {
    code: null,
    signal: null,
  };

  constructor(private readonly opts: McpClientOpts) {
    const { command, serverName } = opts;
    this._serverName = serverName ?? command.split('/').at(-1) ?? command;
    this._initTimeoutMs =
      opts.initializeTimeoutMs ?? (Number(process.env.MCP_INITIALIZE_TIMEOUT_MS) || 30000);
    this._callTimeoutMs = opts.callTimeoutMs ?? (Number(process.env.MCP_CALL_TIMEOUT_MS) || 30000);
    this._logger = opts.logger;
  }

  isFaulted(): boolean {
    return this._faulted;
  }

  onUnexpectedExit(
    handler: (info: { code: number | null; signal: NodeJS.Signals | null }) => void,
  ): void {
    this._unexpectedExitHandler = handler;
    // If we're already in faulted state and the exit has already been detected,
    // fire immediately (handles race where handler is registered after crash).
    if (this._faulted && !this._unexpectedExitFired) {
      this._fireUnexpectedExit(this._lastExitInfo);
    }
  }

  async initialize(): Promise<void> {
    const { command, args, env, logPath } = this.opts;

    // Resolve stderr destination.  Per U4: logger never writes to stdout.
    // Stderr log routing: if logPath is provided, try to open a write stream.
    // Fail gracefully — never crash the client because a log file couldn't open.
    let stderrDest: 'pipe' | 'inherit' = 'inherit';
    if (logPath) {
      try {
        mkdirSync(dirname(logPath), { recursive: true });
        stderrDest = 'pipe';
      } catch {
        this._logger.warn({ msg: 'McpClient: could not prepare log dir', logPath });
      }
    }

    const transport = new StdioClientTransport({
      command,
      args,
      env,
      stderr: stderrDest,
    });

    // Route stderr to log file if requested.
    if (stderrDest === 'pipe' && logPath) {
      try {
        const ws = createWriteStream(logPath, { flags: 'a' });
        transport.stderr?.pipe(ws);
      } catch {
        this._logger.warn({ msg: 'McpClient: could not attach stderr pipe', logPath });
      }
    }

    const sdkClient = new Client({ name: 'myceliate', version: '1.0.0' }, { capabilities: {} });

    // Wrap the connect() call in a timeout race.
    const connectPromise = sdkClient.connect(transport);
    const initTimeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`McpClient: initialize timed out after ${this._initTimeoutMs}ms`)),
        this._initTimeoutMs,
      ).unref(),
    );

    try {
      await Promise.race([connectPromise, initTimeoutPromise]);
    } catch (err) {
      // Clean up — try to close the transport we partially opened.
      await transport.close().catch(() => {});
      throw err;
    }

    // After connect() returns, the SDK has installed its own transport.onclose hook;
    // we wrap it so our _handleTransportClose fires AFTER the SDK's internal cleanup.
    // Note: transport.onclose gives no code/signal (SDK drops them from the child
    // process 'close' event).  We infer "unexpected" vs. clean shutdown via _closing flag.
    const chainedOnclose = transport.onclose;
    transport.onclose = () => {
      chainedOnclose?.();
      this._handleTransportClose({ code: null, signal: null });
    };

    this._transport = transport;
    this._sdkClient = sdkClient;
    this._logger.debug({ msg: 'McpClient: initialized', server: this._serverName });
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    this._assertNotFaulted('listTools');
    const sdkClient = this._requireClient();
    const result = await sdkClient.listTools();
    return result.tools.map((t) => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: t.inputSchema as Record<string, unknown>,
    }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    if (this._faulted) {
      throw new McpServerCrashedError(this._serverName, this._lastExitInfo);
    }
    const sdkClient = this._requireClient();

    // Hang protection: race the SDK call against a timeout.
    // On timeout, we reject with McpToolTimeoutError but do NOT cancel the SDK-side
    // promise — there is no JSON-RPC cancellation primitive in the protocol.  The
    // underlying child may still be working.  client.close() is the only interrupt.
    const callPromise = sdkClient.callTool({ name, arguments: args });
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => {
        reject(new McpToolTimeoutError(this._serverName, name, this._callTimeoutMs));
      }, this._callTimeoutMs).unref(),
    );

    const raw = await Promise.race([callPromise, timeoutPromise]);

    // Normalise the SDK result into our stable McpToolResult shape.
    // The SDK callTool result is a union; we handle both the normal content case
    // and the legacy compatibility toolResult case.
    if ('toolResult' in raw) {
      // Legacy CompatibilityCallToolResult — wrap in content
      return {
        content: [{ type: 'text', text: JSON.stringify(raw.toolResult) }],
        isError: false,
      };
    }

    const content: McpToolResult['content'] = [];
    for (const item of raw.content ?? []) {
      if (item.type === 'text') {
        content.push({ type: 'text' as const, text: item.text });
      } else if (item.type === 'image') {
        content.push({ type: 'image' as const, data: item.data, mimeType: item.mimeType });
      }
      // audio, resource, resource_link — skip; not in our McpToolResult shape
    }

    return { content, isError: raw.isError ?? false };
  }

  async close(): Promise<void> {
    this._closing = true;
    if (this._transport) {
      await this._transport.close().catch(() => {});
      this._transport = null;
    }
    this._sdkClient = null;
    this._logger.debug({ msg: 'McpClient: closed', server: this._serverName });
  }

  getChildPid(): number | null {
    // StdioClientTransport.pid is a public getter (verified in SDK dist/esm/client/stdio.js).
    // Returns undefined → null coercion when the process hasn't started or has already exited.
    return this._transport?.pid ?? null;
  }

  // ─── Private helpers ──────────────────────────────────────────────────────────

  private _requireClient(): Client {
    if (!this._sdkClient) throw new Error('McpClient: not initialized — call initialize() first');
    return this._sdkClient;
  }

  private _assertNotFaulted(op: string): void {
    if (this._faulted) {
      throw new McpServerCrashedError(this._serverName, this._lastExitInfo);
    }
    if (!this._sdkClient) {
      throw new Error(`McpClient: cannot ${op} — client not initialized`);
    }
  }

  private _handleTransportClose(info: {
    code: number | null;
    signal: NodeJS.Signals | null;
  }): void {
    if (this._closing) {
      // Clean caller-initiated shutdown — do NOT fire onUnexpectedExit.
      return;
    }
    // Unexpected exit: transition to faulted state.
    this._lastExitInfo = info;
    this._faulted = true;
    this._logger.warn({
      msg: 'McpClient: unexpected child exit',
      server: this._serverName,
      code: info.code,
      signal: info.signal,
    });
    this._fireUnexpectedExit(info);
  }

  private _fireUnexpectedExit(info: { code: number | null; signal: NodeJS.Signals | null }): void {
    if (this._unexpectedExitFired) return; // one-shot
    this._unexpectedExitFired = true;
    this._unexpectedExitHandler?.(info);
  }
}
