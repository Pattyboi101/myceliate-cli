import { describe, expect, it, vi } from 'vitest';
import { HitlGate } from '../../../src/security/hitlGate.js';
import { createBashTool } from '../../../src/tools/bash.js';
import { ToolDeniedByAllowlistError, ToolRegistry } from '../../../src/tools/registry.js';

describe('ToolRegistry allowlist + HITL non-bypass', () => {
  it('allowlist grants schema presence, NOT execution privilege — bash still routes through HITL', async () => {
    // Phase 23 post-Gemini fix: an allowlisted bash tool MUST still trigger
    // the HITL gate on dangerous commands. The allowlist controls visibility,
    // not privilege. A future refactor that "trusts" allowlisted tools and
    // skips HITL would bypass the dangerous-pattern check — this test fails
    // in CI if that happens. Comments don't fail in CI; assertions do.
    const requestApproval = vi.fn(async () => ({
      decision: 'reject' as const,
      feedback: 'test rejection',
    }));
    const hitl = new HitlGate({ requestApproval });
    const queue = { add: vi.fn() };
    const tool = createBashTool({
      hitl,
      queue: queue as never,
      queueEvents: {} as never,
      defaultTimeoutMs: 1000,
    });

    const r = new ToolRegistry();
    r.register(tool);
    r.setActiveAllowlist(['bash']);

    // Dangerous command — must trip HITL via the dangerous-pattern blocklist.
    await expect(
      r.invoke('bash', { command: 'rm -rf /' }, { cwd: '/tmp', toolUseId: 'test-id' }),
    ).rejects.toThrow(/test rejection/);

    // Load-bearing assertion: HITL was called even though bash is allowlisted.
    expect(requestApproval).toHaveBeenCalledOnce();
    // Queue was NOT reached — HITL rejected before dispatch.
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('dispatch gate fires BEFORE HITL when the tool is denied by allowlist', async () => {
    // Topology check: when a tool is denied by the allowlist, dispatch fails
    // at the gate — we never even call tool.run(), so HITL is not reached.
    // Layering: allowlist denial > tool.run > HITL gate.
    const requestApproval = vi.fn();
    const hitl = new HitlGate({ requestApproval });
    const queue = { add: vi.fn() };
    const tool = createBashTool({
      hitl,
      queue: queue as never,
      queueEvents: {} as never,
      defaultTimeoutMs: 1000,
    });

    const r = new ToolRegistry();
    r.register(tool);
    r.setActiveAllowlist([]); // bash NOT allowed (zero-execution-tools mode)

    await expect(
      r.invoke('bash', { command: 'rm -rf /' }, { cwd: '/tmp', toolUseId: 'test-id' }),
    ).rejects.toThrow(ToolDeniedByAllowlistError);

    expect(requestApproval).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });
});
