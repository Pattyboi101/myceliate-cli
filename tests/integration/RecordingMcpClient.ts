// tests/integration/RecordingMcpClient.ts
//
// Drop-in McpClient implementation that captures every call for test assertion.
// Satisfies the full McpClient interface (T30).
//
// Usage:
//   const client = new RecordingMcpClient({ predeclaredTools: [...], cannedResult: {...} });
//   await client.initialize();
//   // ... run code that calls client ...
//   const calls = client.getCalls(); // [ { name, args, ts }, ... ]

import type { McpClient, McpToolDescriptor, McpToolResult } from '../../src/mcp/McpClient.js';

export interface RecordedCall {
  name: string;
  args: Record<string, unknown>;
  ts: number;
}

export interface RecordingMcpClientOpts {
  predeclaredTools: McpToolDescriptor[];
  cannedResult?: McpToolResult;
}

const DEFAULT_CANNED_RESULT: McpToolResult = {
  content: [{ type: 'text', text: 'ok' }],
  isError: false,
};

export class RecordingMcpClient implements McpClient {
  private readonly _tools: McpToolDescriptor[];
  private readonly _cannedResult: McpToolResult;
  private readonly _calls: RecordedCall[] = [];
  private _unexpectedExitHandler:
    | ((info: { code: number | null; signal: NodeJS.Signals | null }) => void)
    | null = null;

  constructor(opts: RecordingMcpClientOpts) {
    this._tools = opts.predeclaredTools;
    this._cannedResult = opts.cannedResult ?? DEFAULT_CANNED_RESULT;
  }

  async initialize(): Promise<void> {
    // No-op — no real child process to start.
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    return this._tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    this._calls.push({ name, args, ts: Date.now() });
    return this._cannedResult;
  }

  async close(): Promise<void> {
    // No-op — no real child process to clean up.
  }

  isFaulted(): boolean {
    // Recording variant never models crash state.
    return false;
  }

  onUnexpectedExit(
    handler: (info: { code: number | null; signal: NodeJS.Signals | null }) => void,
  ): void {
    // Store but never invoke — recording variant never exits unexpectedly.
    this._unexpectedExitHandler = handler;
  }

  getChildPid(): number | null {
    // No real child process.
    return null;
  }

  // ─── Test inspection ────────────────────────────────────────────────────────

  /** Returns all recorded callTool invocations in order. */
  getCalls(): RecordedCall[] {
    return [...this._calls];
  }

  /** Accessor for the stored unexpected-exit handler (test-only). */
  getUnexpectedExitHandler():
    | ((info: {
        code: number | null;
        signal: NodeJS.Signals | null;
      }) => void)
    | null {
    return this._unexpectedExitHandler;
  }
}
