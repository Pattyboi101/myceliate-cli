import type { StreamEvent } from '../streamEvent.js';

/**
 * DSML wire constants. Exported so the leak-fallback module can guard on
 * presence without re-stating the literal.
 */
export const OPEN_BLOCK = '<|DSML|tool_calls>';
export const CLOSE_BLOCK = '</|DSML|tool_calls>';
const PARAM_CLOSE = '</param>';

type Mode = 'content' | 'block';

type PendingParam = { key: string; isString: boolean; value: string };
type PendingCall = {
  id: string;
  name: string;
  params: PendingParam[];
  current: PendingParam | null;
};

/**
 * DSML escape contract (XML 1.0 entity subset).
 *
 * String-mode param values, attribute values (id, name, key), and the body of
 * `string="false"` params (the JSON literal) all carry these entities so that
 * `<`, `>`, `&`, `"`, `'` inside user data never produce malformed markup.
 *
 * The parser unescapes after extracting the raw substring; the serialiser
 * (`serializeArgs` in the V4 adapter) escapes before emitting.
 */
const ESCAPE_RE = /[&<>"']/g;
const ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};
const UNESCAPE_RE = /&(amp|lt|gt|quot|apos);/g;
const UNESCAPE_MAP: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

export function escapeXml(s: string): string {
  return s.replace(ESCAPE_RE, (c) => ESCAPE_MAP[c] ?? c);
}
export function unescapeXml(s: string): string {
  return s.replace(UNESCAPE_RE, (_, name: string) => UNESCAPE_MAP[name] ?? _);
}

/** Memoised attribute matchers — avoid `new RegExp` per tag. */
const ATTR_REGEXES: Record<string, RegExp> = {
  id: /id="([^"]*)"/,
  name: /name="([^"]*)"/,
  key: /key="([^"]*)"/,
  string: /string="([^"]*)"/,
};

export class DsmlParser {
  private buffer = '';
  private mode: Mode = 'content';
  private call: PendingCall | null = null;

  feed(chunk: string): StreamEvent[] {
    this.buffer += chunk;
    const out: StreamEvent[] = [];
    let progress = true;
    while (progress) {
      progress = false;
      if (this.mode === 'content') {
        const openIdx = this.buffer.indexOf(OPEN_BLOCK);
        if (openIdx === -1) {
          // Emit the prefix that cannot start `OPEN_BLOCK`. Withhold the rest in case
          // the next feed completes a partial marker.
          const safe = this.safeContentPrefix(this.buffer);
          if (safe.length > 0) {
            out.push({ type: 'content_delta', text: safe });
            this.buffer = this.buffer.slice(safe.length);
          }
        } else {
          if (openIdx > 0) {
            out.push({ type: 'content_delta', text: this.buffer.slice(0, openIdx) });
          }
          this.buffer = this.buffer.slice(openIdx + OPEN_BLOCK.length);
          this.mode = 'block';
          progress = true;
        }
      } else {
        const closeIdx = this.buffer.indexOf(CLOSE_BLOCK);
        const segmentEnd = closeIdx === -1 ? this.buffer.length : closeIdx;
        const consumed = this.consumeBlockSegment(this.buffer.slice(0, segmentEnd), out);
        // Always advance buffer by consumed bytes so we don't reprocess on the next feed.
        this.buffer = this.buffer.slice(consumed);
        if (closeIdx !== -1 && consumed === segmentEnd) {
          // consumed === segmentEnd means we ate up to (but not including) the close marker.
          this.buffer = this.buffer.slice(CLOSE_BLOCK.length);
          this.mode = 'content';
          this.call = null;
          progress = true;
        }
      }
    }
    return out;
  }

  /**
   * End-of-stream cleanup. Emits any tail buffered in content mode as a final
   * `content_delta` (the safe-prefix trick withholds bytes that *could* start
   * an OPEN_BLOCK; once the upstream signals it's done, those bytes are real
   * content). Drops anything left in block mode — incomplete tool calls are
   * not emitted to avoid silently dispatching half-formed intents.
   */
  flush(): StreamEvent[] {
    if (this.mode === 'content' && this.buffer.length > 0) {
      const remaining = this.buffer;
      this.buffer = '';
      return [{ type: 'content_delta', text: remaining }];
    }
    return [];
  }

  /** Returns the prefix of `s` that is guaranteed not to start `OPEN_BLOCK`. */
  private safeContentPrefix(s: string): string {
    for (let i = 1; i < OPEN_BLOCK.length && i <= s.length; i++) {
      const tail = s.slice(s.length - i);
      if (OPEN_BLOCK.startsWith(tail)) return s.slice(0, s.length - i);
    }
    return s;
  }

  /**
   * Consume one segment of block-mode bytes. Returns the number of bytes consumed.
   *
   * Tag tokenisation is mode-aware: when inside a `<param>` value, we scan
   * specifically for `</param>` rather than treating any `<...>` as a tag —
   * otherwise a literal `<` in a string-mode value would consume the param's
   * close marker and silently drop the param.
   */
  private consumeBlockSegment(segment: string, out: StreamEvent[]): number {
    let i = 0;
    while (i < segment.length) {
      // Inside a param value: scan to </param>, treat the rest as raw value.
      if (this.call?.current) {
        const closeIdx = segment.indexOf(PARAM_CLOSE, i);
        if (closeIdx === -1) {
          // No close yet — append everything to the value and signal we ate the segment.
          this.call.current.value += segment.slice(i);
          return segment.length;
        }
        this.call.current.value += segment.slice(i, closeIdx);
        const finalized = this.call.current;
        this.call.current = null;
        // Unescape on finalise. JSON-mode values: parsed downstream by safeJsonParse,
        // which expects already-unescaped JSON.
        finalized.value = unescapeXml(finalized.value);
        this.call.params.push(finalized);
        i = closeIdx + PARAM_CLOSE.length;
        continue;
      }

      // Outside param value: recognise tags.
      const lt = segment.indexOf('<', i);
      if (lt === -1) {
        // No more tags — but no param open either, so trailing text is just whitespace
        // between tags. Ignore.
        return segment.length;
      }
      i = lt;
      const gt = segment.indexOf('>', lt);
      if (gt === -1) return i; // Incomplete tag; wait for more bytes.
      const tag = segment.slice(lt, gt + 1);
      i = gt + 1;

      if (tag.startsWith('<call ')) {
        const id = unescapeXml(readAttr(tag, 'id'));
        const name = unescapeXml(readAttr(tag, 'name'));
        this.call = { id, name, params: [], current: null };
      } else if (tag === '</call>') {
        if (this.call) {
          const args: Record<string, unknown> = {};
          for (const p of this.call.params) {
            args[p.key] = p.isString ? p.value : safeJsonParse(p.value);
          }
          out.push({ type: 'tool_call', id: this.call.id, name: this.call.name, args });
          this.call = null;
        }
      } else if (tag.startsWith('<param ')) {
        if (this.call) {
          const key = unescapeXml(readAttr(tag, 'key'));
          const isString = readAttr(tag, 'string') === 'true';
          this.call.current = { key, isString, value: '' };
        }
      }
      // Any other shape between calls is silently ignored (malformed upstream).
    }
    return i;
  }
}

function readAttr(tag: string, name: string): string {
  const re = ATTR_REGEXES[name];
  if (!re) return '';
  const m = tag.match(re);
  return m?.[1] ?? '';
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
