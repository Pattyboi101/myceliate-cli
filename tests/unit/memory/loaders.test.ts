// tests/unit/memory/loaders.test.ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadProjectClaudeMd } from '../../../src/memory/claudeMd.js';
import { ConversationLog } from '../../../src/memory/conversationLog.js';
import { MarkdownStore } from '../../../src/memory/markdownStore.js';

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'myc-load-'));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('memory loaders', () => {
  it('loadProjectClaudeMd returns the file contents when present', async () => {
    await writeFile(join(tmp, 'CLAUDE.md'), '# Constraints\nstrict TS', 'utf8');
    const text = await loadProjectClaudeMd(tmp);
    expect(text).toContain('strict TS');
  });

  it('loadProjectClaudeMd returns empty string when file is missing', async () => {
    const text = await loadProjectClaudeMd(tmp);
    expect(text).toBe('');
  });

  it('loadProjectClaudeMd returns contents verbatim (no trimming)', async () => {
    const raw = '  # Leading spaces\n\ntrailing newline\n';
    await writeFile(join(tmp, 'CLAUDE.md'), raw, 'utf8');
    const text = await loadProjectClaudeMd(tmp);
    expect(text).toBe(raw);
  });

  it('ConversationLog appends turn records under history/<session>.md', async () => {
    const store = new MarkdownStore(join(tmp, '.myceliate'));
    const log = new ConversationLog(store, 'sess-1');
    await log.appendTurn({ role: 'user', content: 'hi' });
    await log.appendTurn({ role: 'assistant', content: 'hello' });
    const rec = await store.read('history/sess-1.md');
    expect(rec.frontmatter.sessionId).toBe('sess-1');
    expect(rec.body).toContain('### user');
    expect(rec.body).toContain('### assistant');
    expect(rec.body).toContain('hi');
    expect(rec.body).toContain('hello');
  });

  it('ConversationLog writes frontmatter only once on first appendTurn (initialized flag)', async () => {
    const store = new MarkdownStore(join(tmp, '.myceliate'));
    const log = new ConversationLog(store, 'sess-once');
    await log.appendTurn({ role: 'user', content: 'first' });
    await log.appendTurn({ role: 'user', content: 'second' });
    await log.appendTurn({ role: 'user', content: 'third' });
    const rec = await store.read('history/sess-once.md');
    // sessionId should appear exactly once in the frontmatter area —
    // if write() was called more than once the body would start fresh each time
    // and the prior turns would be lost.
    expect(rec.body).toContain('first');
    expect(rec.body).toContain('second');
    expect(rec.body).toContain('third');
    // Only one frontmatter block: count '---' occurrences in raw file
    const raw = `---\n${JSON.stringify(rec.frontmatter)}\n---\n${rec.body}`;
    // The frontmatter sessionId must be present exactly once
    const sessionIdMatches = rec.body.match(/sessionId/g);
    expect(sessionIdMatches).toBeNull();
  });

  it('ConversationLog renders a tool-role message correctly', async () => {
    const store = new MarkdownStore(join(tmp, '.myceliate'));
    const log = new ConversationLog(store, 'sess-tool');
    await log.appendTurn({
      role: 'tool',
      result: {
        tool_use_id: 'tu-123',
        command: 'grep foo bar.ts',
        is_error: false,
        content: 'bar.ts:42: foo',
      },
    });
    const rec = await store.read('history/sess-tool.md');
    expect(rec.body).toContain('### tool');
    expect(rec.body).toContain('tu-123');
    expect(rec.body).toContain('bar.ts:42: foo');
    expect(rec.body).toContain('OK');
  });

  it('ConversationLog renders a tool-role message with is_error=true', async () => {
    const store = new MarkdownStore(join(tmp, '.myceliate'));
    const log = new ConversationLog(store, 'sess-tool-err');
    await log.appendTurn({
      role: 'tool',
      result: {
        tool_use_id: 'tu-456',
        command: 'bash fail.sh',
        is_error: true,
        content: 'exit code 1',
      },
    });
    const rec = await store.read('history/sess-tool-err.md');
    expect(rec.body).toContain('ERROR');
    expect(rec.body).toContain('exit code 1');
  });

  it('ConversationLog renders assistant message with tool_calls', async () => {
    const store = new MarkdownStore(join(tmp, '.myceliate'));
    const log = new ConversationLog(store, 'sess-tc');
    await log.appendTurn({
      role: 'assistant',
      content: 'Let me grep for you.',
      tool_calls: [{ id: 'tc-1', name: 'grep', args: { pattern: 'foo', path: '.' } }],
    });
    const rec = await store.read('history/sess-tc.md');
    expect(rec.body).toContain('### assistant');
    expect(rec.body).toContain('tool_calls');
    expect(rec.body).toContain('grep');
  });

  it('ConversationLog renders assistant message with reasoning_content', async () => {
    const store = new MarkdownStore(join(tmp, '.myceliate'));
    const log = new ConversationLog(store, 'sess-rc');
    await log.appendTurn({
      role: 'assistant',
      content: 'The answer is 42.',
      reasoning_content: 'I reasoned carefully.',
    });
    const rec = await store.read('history/sess-rc.md');
    expect(rec.body).toContain('<details>');
    expect(rec.body).toContain('reasoning');
    expect(rec.body).toContain('I reasoned carefully.');
  });
});
