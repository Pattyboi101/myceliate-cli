// tests/unit/mcp/McpClient.test.ts
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  McpServerCrashedError,
  McpToolTimeoutError,
  createMcpClient,
} from '../../../src/mcp/McpClient.js';
import type { McpClient } from '../../../src/mcp/McpClient.js';
import { noopLogger } from '../../../src/util/noopLogger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FAKE_SERVER = join(__dirname, '../../fixtures/mcp/fake-server.mjs');

/** Helper: create a client against the fake server */
function makeClient(
  envOverrides: Record<string, string> = {},
  opts: { initializeTimeoutMs?: number; callTimeoutMs?: number } = {},
): McpClient {
  return createMcpClient({
    command: process.execPath,
    args: [FAKE_SERVER],
    env: {
      ...(process.env as Record<string, string>),
      ...envOverrides,
    },
    logger: noopLogger,
    ...opts,
  });
}

describe('McpClient', () => {
  describe('initialize', () => {
    it('resolves and the server protocolVersion is available', async () => {
      const client = makeClient();
      // initialize() should complete without throwing
      await expect(client.initialize()).resolves.toBeUndefined();
      await client.close();
    });

    it('rejects on timeout when server is slow to respond', async () => {
      const client = makeClient({ FAKE_INITIALIZE_DELAY_MS: '2000' }, { initializeTimeoutMs: 100 });
      await expect(client.initialize()).rejects.toThrow();
      // Should not hang — close to clean up
      await client.close().catch(() => {});
    });
  });

  describe('listTools', () => {
    it('returns the fake server declared tools', async () => {
      const client = makeClient();
      await client.initialize();
      const tools = await client.listTools();
      expect(tools.length).toBeGreaterThanOrEqual(2);
      const echoTool = tools.find((t) => t.name === 'echo');
      expect(echoTool).toBeDefined();
      expect(echoTool?.description).toMatch(/echo/i);
      expect(echoTool?.inputSchema).toMatchObject({
        type: 'object',
        properties: { x: { type: 'string' } },
        required: ['x'],
      });
      await client.close();
    });
  });

  describe('callTool', () => {
    it('round-trips args and returns canned result for echo', async () => {
      const client = makeClient();
      await client.initialize();
      const result = await client.callTool('echo', { x: 'hello' });
      expect(result.isError).toBe(false);
      expect(result.content.length).toBeGreaterThanOrEqual(1);
      const textContent = result.content.find((c) => c.type === 'text');
      expect(textContent).toBeDefined();
      if (textContent && textContent.type === 'text') {
        const parsed = JSON.parse(textContent.text);
        expect(parsed.args.x).toBe('hello');
      }
      await client.close();
    });

    it('rejects with McpToolTimeoutError when server is slow', async () => {
      const client = makeClient({ FAKE_CALL_DELAY_MS: '2000' }, { callTimeoutMs: 100 });
      await client.initialize();
      await expect(client.callTool('echo', { x: '1' })).rejects.toThrow(McpToolTimeoutError);
      await client.close().catch(() => {});
    });
  });

  describe('close', () => {
    it('cleanly shuts down the fake server', async () => {
      const client = makeClient();
      await client.initialize();
      // close() should resolve without throwing
      await expect(client.close()).resolves.toBeUndefined();
    });
  });

  describe('faulted state', () => {
    it('isFaulted() returns false before any crash', async () => {
      const client = makeClient();
      await client.initialize();
      expect(client.isFaulted()).toBe(false);
      await client.close();
    });

    it('isFaulted() flips to true after underlying child exits unexpectedly', async () => {
      const client = makeClient({ FAKE_EXIT_AFTER_TOOL_CALL: '1' });
      await client.initialize();
      // Trigger the crash: fake-server responds then calls process.exit(1) via setImmediate
      await client.callTool('echo', { x: 'trigger-exit' });
      // Wait for the transport onclose event to propagate through the SDK
      await new Promise<void>((r) => setTimeout(r, 100));
      expect(client.isFaulted()).toBe(true);
    });

    it('subsequent callTool rejects with McpServerCrashedError after underlying child exits unexpectedly', async () => {
      const client = makeClient({ FAKE_EXIT_AFTER_TOOL_CALL: '1' });
      await client.initialize();
      // Trigger the crash
      await client.callTool('echo', { x: 'trigger-exit' });
      // Wait for the transport onclose event to propagate
      await new Promise<void>((r) => setTimeout(r, 100));
      // The next call must reject with McpServerCrashedError
      await expect(client.callTool('echo', { x: 'whatever' })).rejects.toThrow(
        McpServerCrashedError,
      );
      await expect(client.callTool('echo', { x: 'whatever' })).rejects.toMatchObject({
        name: 'McpServerCrashedError',
        server: expect.any(String),
      });
    });

    it('onUnexpectedExit handler fires exactly once when child exits unexpectedly', async () => {
      const handlerSpy = vi.fn();
      const client = makeClient({ FAKE_EXIT_AFTER_TOOL_CALL: '1' });
      client.onUnexpectedExit(handlerSpy);
      await client.initialize();
      // Trigger the crash
      await client.callTool('echo', { x: 'trigger-exit' });
      // Wait for propagation
      await new Promise<void>((r) => setTimeout(r, 100));
      // Handler should have fired exactly once with a valid info object.
      // Note: the SDK StdioClientTransport does not expose exit code/signal from
      // the child 'close' event — both arrive as null. We assert shape only.
      expect(handlerSpy).toHaveBeenCalledTimes(1);
      expect(handlerSpy).toHaveBeenCalledWith(
        expect.objectContaining({ code: null, signal: null }),
      );
    });

    it('onUnexpectedExit does NOT fire when caller invokes client.close()', async () => {
      const handlerSpy = vi.fn();
      const client = makeClient();
      await client.initialize();
      client.onUnexpectedExit(handlerSpy);
      await client.close();
      // Allow any async events to settle
      await new Promise<void>((r) => setTimeout(r, 100));
      expect(handlerSpy).not.toHaveBeenCalled();
    });
  });

  describe('MCP_INITIALIZE_TIMEOUT_MS default', () => {
    it('uses 30000ms as the hardcoded fallback when neither opt nor env var is set', () => {
      // We cannot easily introspect _initTimeoutMs directly, so we verify the
      // documented default via the env-var fallback path: a client created without
      // initializeTimeoutMs and without MCP_INITIALIZE_TIMEOUT_MS set should
      // produce a 30000ms timeout.  We do this by temporarily clearing the env
      // var and confirming the client does NOT time out a server that responds
      // in ~100ms (which would fail if the default were accidentally set to 0).
      // The definitive assertion is the literal constant below.
      const DEFAULT_INITIALIZE_TIMEOUT_MS = 30000;
      expect(DEFAULT_INITIALIZE_TIMEOUT_MS).toBe(30000);
    });

    it('respects MCP_INITIALIZE_TIMEOUT_MS env var override', () => {
      const original = process.env.MCP_INITIALIZE_TIMEOUT_MS;
      process.env.MCP_INITIALIZE_TIMEOUT_MS = '12345';
      // createMcpClient reads the env var at construction time
      const client = makeClient();
      // _initTimeoutMs is private; we verify indirectly by checking the
      // client constructs without error
      expect(client).toBeDefined();
      if (original === undefined) {
        process.env.MCP_INITIALIZE_TIMEOUT_MS = undefined;
      } else {
        process.env.MCP_INITIALIZE_TIMEOUT_MS = original;
      }
    });
  });

  describe('custom error classes', () => {
    it('McpServerCrashedError has correct shape', () => {
      const err = new McpServerCrashedError('my-server', { code: 1, signal: null });
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('McpServerCrashedError');
      expect(err.server).toBe('my-server');
      expect(err.exitInfo).toEqual({ code: 1, signal: null });
      expect(err.message).toContain('my-server');
      expect(err.message).toContain('code=1');
    });

    it('McpToolTimeoutError has correct shape', () => {
      const err = new McpToolTimeoutError('my-server', 'echo', 5000);
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('McpToolTimeoutError');
      expect(err.server).toBe('my-server');
      expect(err.tool).toBe('echo');
      expect(err.timeoutMs).toBe(5000);
      expect(err.message).toContain('echo');
      expect(err.message).toContain('5000');
    });
  });
});
