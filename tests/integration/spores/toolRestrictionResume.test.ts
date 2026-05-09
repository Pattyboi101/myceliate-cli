import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConversationLog } from '../../../src/memory/conversationLog.js';
import { MarkdownStore } from '../../../src/memory/markdownStore.js';
import { bootTools } from '../../../src/runtime/bootTools.js';
import type { HitlGate } from '../../../src/security/hitlGate.js';
import type { Spore } from '../../../src/spores/Spore.js';
import { SporeRegistry } from '../../../src/spores/SporeRegistry.js';
import { ToolDeniedByAllowlistError } from '../../../src/tools/registry.js';
import type { Logger } from '../../../src/util/logger.js';

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  flush: async () => {},
};

const fakeHitl: HitlGate = {
  requestApproval: async () => ({ decision: 'approve' }),
} as unknown as HitlGate;

function mkSpore(name: string, allowedTools: string[] | undefined): Spore {
  return {
    name,
    tier: 'bundled',
    dir: `/fake/${name}`,
    manifest: {
      name,
      description: 'desc',
      version: '1.0.0',
      accent_color: '#000000',
      keywords: [],
      agents: [],
      ...(allowedTools !== undefined ? { allowed_tools: allowedTools } : {}),
    },
    sectorFrontmatter: { name, description: 'desc' },
    sectorSkillPath: `/fake/${name}/SKILL.md`,
    personas: [],
    commands: [],
  };
}

describe('Phase 23 integration — allowlist + --resume rehydration', () => {
  // v1.4 --resume only reconstructs message history without re-invoking
  // historical tool_calls. This test verifies (a) rehydration via
  // ConversationLog.readSession does not crash when history references
  // tools no longer in the active allowlist, and (b) the dispatch gate
  // unconditionally denies any live invoke (model-issued or hallucinated).
  // There is no bypass flag — the gate is unconditional, derived from the
  // schema layer (getActiveTools).
  it('rehydrates message history with denied tool_calls + dispatch gate denies live invokes', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'myc-resume-'));
    try {
      const sessionId = 'test-session';

      // 1. Write a synthetic .jsonl with a user turn + an assistant tool_call
      //    to write_file, plus the corresponding tool result.
      const histDir = join(cwd, '.myceliate', 'history');
      await mkdir(histDir, { recursive: true });
      const lines = `${[
        JSON.stringify({ role: 'user', content: 'do something' }),
        JSON.stringify({
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'c1', name: 'write_file', args: { path: 'x', content: 'y' } }],
        }),
        JSON.stringify({
          role: 'tool',
          result: {
            tool_use_id: 'c1',
            command: 'write_file ...',
            is_error: false,
            content: 'ok',
          },
        }),
      ].join('\n')}\n`;
      await writeFile(join(histDir, `${sessionId}.jsonl`), lines, 'utf8');

      // 2. Create a registry where the active spore allows ONLY read_file.
      const registry = SporeRegistry.fromList([mkSpore('restricted', ['read_file'])]);
      const store = new MarkdownStore(join(cwd, '.myceliate'));

      // 3. bootTools, setActiveSpore('restricted').
      const { tools, setActiveSpore } = bootTools({
        hitl: fakeHitl,
        registry,
        logger: noopLogger,
      });
      setActiveSpore('restricted');

      // 4. Read session history via ConversationLog.readSession.
      const messages = await ConversationLog.readSession(store, sessionId);

      // 5a. readSession returns 3 messages (no crash on the denied tool_call).
      expect(messages).toHaveLength(3);

      // 5b. tools.definitions() does NOT include write_file (schema-layer filter).
      const defNames = tools.definitions().map((d) => d.name);
      expect(defNames).not.toContain('write_file');
      expect(defNames).toContain('read_file');

      // 5c. invoke() of a denied tool THROWS ToolDeniedByAllowlistError. The
      //     orchestrator's dispatch gate is unconditional — there is no
      //     historical-replay bypass in v1.4 because --resume only reconstructs
      //     message history (no invoke). Hallucinated tool_calls (Gemini Case 4)
      //     and any future bypass route still hit this gate.
      await expect(tools.invoke('write_file', { path: 'x', content: 'y' })).rejects.toThrow(
        ToolDeniedByAllowlistError,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
