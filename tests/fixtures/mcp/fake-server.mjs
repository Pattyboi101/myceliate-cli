#!/usr/bin/env node
/**
 * Minimal MCP fake server speaking JSON-RPC 2.0 over stdin/stdout (newline-delimited).
 *
 * Env vars:
 *   FAKE_INITIALIZE_DELAY_MS  — delay (ms) before responding to initialize
 *   FAKE_CALL_DELAY_MS        — delay (ms) before responding to tools/call
 *   FAKE_TRAP_SIGTERM=1       — ignore SIGTERM (for SIGKILL escalation tests in T24)
 *   FAKE_DEBUG_TO_STDOUT=1    — write a non-JSON debug line to stdout before first response
 *                               (reproduces the stdio-hygiene corruption scenario)
 *   FAKE_EXIT_AFTER_TOOL_CALL=1 — respond to tools/call normally, then immediately exit(1)
 *                               via setImmediate (simulates unexpected crash mid-session)
 */

import * as readline from 'node:readline';

const initDelayMs = Number(process.env.FAKE_INITIALIZE_DELAY_MS ?? 0);
const callDelayMs = Number(process.env.FAKE_CALL_DELAY_MS ?? 0);
const trapSigterm = process.env.FAKE_TRAP_SIGTERM === '1';
const debugToStdout = process.env.FAKE_DEBUG_TO_STDOUT === '1';
const exitAfterToolCall = process.env.FAKE_EXIT_AFTER_TOOL_CALL === '1';

if (trapSigterm) {
  process.on('SIGTERM', () => {
    // intentionally ignore — caller must SIGKILL
  });
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** @param {unknown} result @param {string|number} id */
function respond(result, id) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, result });
  process.stdout.write(`${msg}\n`);
}

/** @param {{ code: number; message: string }} error @param {string|number} id */
function respondError(error, id) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, error });
  process.stdout.write(`${msg}\n`);
}

const TOOLS = [
  {
    name: 'echo',
    description: 'Echoes its input back as JSON text',
    inputSchema: {
      type: 'object',
      properties: { x: { type: 'string' } },
      required: ['x'],
    },
  },
  {
    name: 'add',
    description: 'Adds two numbers',
    inputSchema: {
      type: 'object',
      properties: {
        a: { type: 'number' },
        b: { type: 'number' },
      },
      required: ['a', 'b'],
    },
  },
  {
    name: 'greet',
    description: 'Returns a greeting message',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  },
];

let debugLineWritten = false;

/** @param {string} line */
async function handleLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return;

  let req;
  try {
    req = JSON.parse(trimmed);
  } catch {
    // malformed — ignore
    return;
  }

  const { id, method, params } = req;

  // Write debug non-JSON line before FIRST response if configured.
  // This reproduces the stdio-hygiene corruption scenario.
  if (debugToStdout && !debugLineWritten) {
    debugLineWritten = true;
    process.stdout.write('DEBUG: fake-server starting\n');
  }

  if (method === 'initialize') {
    if (initDelayMs > 0) await sleep(initDelayMs);
    respond(
      {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake', version: '0.0.0' },
      },
      id,
    );
    return;
  }

  if (method === 'notifications/initialized') {
    // No response needed for notifications
    return;
  }

  if (method === 'tools/list') {
    respond({ tools: TOOLS }, id);
    return;
  }

  if (method === 'tools/call') {
    if (callDelayMs > 0) await sleep(callDelayMs);
    const toolName = params?.name ?? '(unknown)';
    const args = params?.arguments ?? {};
    respond(
      {
        content: [{ type: 'text', text: JSON.stringify({ tool: toolName, args }) }],
        isError: false,
      },
      id,
    );
    if (exitAfterToolCall) {
      // Defer exit via setImmediate so the response frame is fully written
      // before the process dies, simulating an unexpected crash mid-session.
      setImmediate(() => process.exit(1));
    }
    return;
  }

  // Unknown method — return a JSON-RPC error
  respondError({ code: -32601, message: `Method not found: ${method}` }, id);
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  void handleLine(line);
});

// When stdin closes, exit cleanly
rl.on('close', () => {
  process.exit(0);
});
