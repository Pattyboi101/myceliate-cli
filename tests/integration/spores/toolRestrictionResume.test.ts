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

describe('Phase 23 integration — --resume across allowlist change', () => {
  it('rehydrates a session whose history contains tool_calls now denied', async () => {
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

      // 5c. invoke() with no flag (simulating a live turn or hallucinated call)
      //     for a denied tool THROWS ToolDeniedByAllowlistError.
      //     This is the LOAD-BEARING defense-in-depth assertion against Case 4
      //     (model hallucinates a tool_call for a tool not in the schema).
      await expect(tools.invoke('write_file', { path: 'x', content: 'y' })).rejects.toThrow(
        ToolDeniedByAllowlistError,
      );

      // 5d. invoke() with isHistoricalReplay bypasses the allowlist gate for
      //     write_file (historical turn used write_file before the allowlist was
      //     changed). The rehydration path must not be blocked — spec §2.3.
      //     Note: write_file will throw a real error (no parent dir in this test),
      //     but the error must NOT be ToolDeniedByAllowlistError.
      try {
        await tools.invoke(
          'write_file',
          { path: '/nonexistent/path/x', content: 'y' },
          { isHistoricalReplay: true },
        );
      } catch (err) {
        // Any error is fine EXCEPT ToolDeniedByAllowlistError — the bypass worked.
        expect(err).not.toBeInstanceOf(ToolDeniedByAllowlistError);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
