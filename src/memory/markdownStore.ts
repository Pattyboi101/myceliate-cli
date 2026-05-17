import { createHash } from 'node:crypto';
// src/memory/markdownStore.ts
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

export type Frontmatter = Record<string, unknown>;

/**
 * A parsed Markdown file: YAML-style frontmatter values + the body text.
 * Named MdRecord to avoid shadowing the TypeScript built-in Record<K,V> utility.
 */
export type MdRecord = {
  frontmatter: Frontmatter;
  body: string;
};

/**
 * Pointer returned by storeArtifact when content exceeds the byte threshold.
 * The id is a deterministic SHA-256 hex prefix derived from the content.
 */
export type ArtifactPointer = {
  kind: 'artifact';
  /** Deterministic: same content → same id. 16 hex chars (64 bits of entropy). */
  id: string;
  /** Relative path under the MarkdownStore root, e.g. 'artifacts/<id>.md'. */
  path: string;
  /** Byte length of the offloaded payload. */
  bytes: number;
  /** First ~200 chars of content, for at-a-glance context in the log. */
  preview: string;
};

export class MarkdownStore {
  // Phase 18: exposed as public so ConversationLog.readSession can construct the
  // .jsonl path without routing through MarkdownStore's frontmatter parser (which
  // would misparse a raw JSON line file as a Markdown record).
  readonly baseDir: string;

  constructor(root: string) {
    this.baseDir = root;
  }

  async write(path: string, frontmatter: Frontmatter, body: string): Promise<void> {
    const abs = join(this.baseDir, path);
    await mkdir(dirname(abs), { recursive: true });
    const fm =
      Object.keys(frontmatter).length === 0 ? '' : `---\n${serializeFrontmatter(frontmatter)}---\n`;
    await writeFile(abs, fm + body, 'utf8');
  }

  async append(path: string, additional: string): Promise<void> {
    const abs = join(this.baseDir, path);
    await mkdir(dirname(abs), { recursive: true });
    await appendFile(abs, additional, 'utf8');
  }

  async read(path: string): Promise<MdRecord> {
    const abs = join(this.baseDir, path);
    const raw = await readFile(abs, 'utf8');
    return parseRecord(raw);
  }

  async list(subdir: string): Promise<string[]> {
    const abs = join(this.baseDir, subdir);
    const out: string[] = [];
    const visit = async (dir: string): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isFile() && e.name.endsWith('.md')) out.push(relative(this.baseDir, full));
        else if (e.isDirectory()) await visit(full);
      }
    };
    try {
      await visit(abs);
    } catch {
      /* missing dir → empty */
    }
    return out;
  }

  /**
   * If the UTF-8 byte length of `content` exceeds `maxBytes`, write the
   * content to `<root>/artifacts/<id>.md` and return an ArtifactPointer.
   * Otherwise, return the content unchanged.
   *
   * Threshold and pointer.bytes use Buffer.byteLength(content, 'utf8'),
   * not content.length — the latter counts UTF-16 code units and would
   * undercount astral content (emoji, certain CJK), letting genuinely
   * over-budget output slip past the threshold.
   *
   * The id is deterministic (SHA-256 hex prefix) so duplicate large outputs
   * don't bloat disk — a second store of identical content overwrites the same file.
   */
  async storeArtifact(
    content: string,
    opts: { maxBytes: number },
  ): Promise<string | ArtifactPointer> {
    const byteLen = Buffer.byteLength(content, 'utf8');
    if (byteLen <= opts.maxBytes) {
      return content;
    }
    const id = contentId(content);
    const artifactPath = `artifacts/${id}.md`;
    const abs = join(this.baseDir, artifactPath);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
    return {
      kind: 'artifact',
      id,
      path: artifactPath,
      bytes: byteLen,
      preview: content.slice(0, 200),
    };
  }

  /**
   * Read the full content of an artifact given its pointer.
   *
   * Use this method, not `read()`, for artifact paths — artifact files
   * have no frontmatter block, so `read()` would feed them through
   * `parseRecord` and silently misparse any artifact whose content
   * happens to start with `---\n`.
   */
  async readArtifact(pointer: ArtifactPointer): Promise<string> {
    const abs = join(this.baseDir, pointer.path);
    return readFile(abs, 'utf8');
  }
}

/** Derive a deterministic 16-char hex id from content using SHA-256. */
function contentId(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
}

function serializeFrontmatter(fm: Frontmatter): string {
  return Object.entries(fm)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}\n`)
    .join('');
}

function parseRecord(raw: string): MdRecord {
  if (!raw.startsWith('---\n')) return { frontmatter: {}, body: raw };
  const end = raw.indexOf('\n---\n', 4);
  if (end === -1) return { frontmatter: {}, body: raw };
  const fmText = raw.slice(4, end);
  const body = raw.slice(end + 5);
  const frontmatter: Frontmatter = {};
  for (const line of fmText.split('\n')) {
    if (!line.trim()) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const k = line.slice(0, colon).trim();
    const v = line.slice(colon + 1).trim();
    try {
      frontmatter[k] = JSON.parse(v);
    } catch {
      frontmatter[k] = v;
    }
  }
  return { frontmatter, body };
}
