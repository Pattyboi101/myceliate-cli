import type { StreamEvent } from '../streamEvent.js';

const OPEN_BLOCK = '<|DSML|tool_calls>';
const CLOSE_BLOCK = '</|DSML|tool_calls>';

type Mode = 'content' | 'block';

type PendingParam = { key: string; isString: boolean; value: string };
type PendingCall = { id: string; name: string; params: PendingParam[]; current: PendingParam | null };

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
          // Emit safe prefix that cannot be the start of OPEN_BLOCK.
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

  /** Returns the prefix of `s` that is guaranteed not to start `OPEN_BLOCK`. */
  private safeContentPrefix(s: string): string {
    for (let i = 1; i < OPEN_BLOCK.length && i <= s.length; i++) {
      const tail = s.slice(s.length - i);
      if (OPEN_BLOCK.startsWith(tail)) return s.slice(0, s.length - i);
    }
    return s;
  }

  private consumeBlockSegment(segment: string, out: StreamEvent[]): number {
    // Minimal tag tokenizer: <call id="..." name="...">, <param key="..." string="...">VALUE</param>, </call>.
    let i = 0;
    while (i < segment.length) {
      const lt = segment.indexOf('<', i);
      if (lt === -1) {
        // No more tags; capture any trailing text for the current param value.
        const text = segment.slice(i);
        if (text.length > 0 && this.call?.current) {
          this.call.current.value += text;
        }
        return segment.length;
      }
      // Capture text between current position and the next tag.
      if (lt > i) {
        const text = segment.slice(i, lt);
        if (text.length > 0 && this.call?.current) {
          this.call.current.value += text;
        }
        i = lt;
      }
      const gt = segment.indexOf('>', lt);
      if (gt === -1) return i; // Incomplete tag; wait for more bytes.
      const tag = segment.slice(lt, gt + 1);
      i = gt + 1;
      if (tag.startsWith('<call ')) {
        const id = readAttr(tag, 'id');
        const name = readAttr(tag, 'name');
        this.call = { id, name, params: [], current: null };
      } else if (tag === '</call>') {
        if (this.call) {
          const args: Record<string, unknown> = {};
          for (const p of this.call.params) args[p.key] = p.isString ? p.value : safeJsonParse(p.value);
          out.push({ type: 'tool_call', id: this.call.id, name: this.call.name, args });
          this.call = null;
        }
      } else if (tag.startsWith('<param ')) {
        if (this.call) {
          const key = readAttr(tag, 'key');
          const isString = readAttr(tag, 'string') === 'true';
          this.call.current = { key, isString, value: '' };
        }
      } else if (tag === '</param>') {
        if (this.call?.current) {
          this.call.params.push(this.call.current);
          this.call.current = null;
        }
      } else {
        // Unknown tag inside a block — treat as part of the current param value verbatim.
        if (this.call?.current) this.call.current.value += tag;
      }
    }
    return i;
  }
}

function readAttr(tag: string, name: string): string {
  const re = new RegExp(`${name}="([^"]*)"`);
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
