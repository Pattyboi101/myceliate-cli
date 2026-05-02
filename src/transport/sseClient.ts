import { Readable } from 'node:stream';

const DATA_PREFIX = 'data:';
const DATA_PREFIX_LEN = DATA_PREFIX.length;
const DONE_MARKER = '[DONE]';

/**
 * Parses an SSE byte stream into a sequence of `data:` payloads.
 *
 * Honors the SSE spec line-terminator rules (HTML Living Standard §9.2):
 * `\r\n`, `\n`, and bare `\r` are all valid event/field separators. We
 * normalise to `\n` on each chunk so the rest of the parser can search for
 * `\n\n` only. Yields the trimmed payload string per event; skips comments
 * (lines beginning with `:`) and empty payloads. Returns on `[DONE]`.
 */
export async function* parseSseStream(
  byteStream: AsyncIterable<Uint8Array>,
): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of byteStream) {
    buffer = normaliseLineEndings(buffer + decoder.decode(chunk, { stream: true }));
    let nl = buffer.indexOf('\n\n');
    while (nl !== -1) {
      const event = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 2);
      nl = buffer.indexOf('\n\n');
      const payload = extractDataPayload(event);
      if (payload === null) continue;
      if (payload === DONE_MARKER) return;
      yield payload;
    }
  }
  // Drain a final event if the stream closed without trailing `\n\n`.
  if (buffer.length > 0) {
    const payload = extractDataPayload(buffer);
    if (payload !== null && payload !== DONE_MARKER) yield payload;
  }
}

/** Collapse CRLF and bare CR to LF. */
function normaliseLineEndings(s: string): string {
  return s.replace(/\r\n?/g, '\n');
}

/** Extract the joined `data:` payload from one SSE event. Returns null for comment-only or empty. */
function extractDataPayload(event: string): string | null {
  const lines = event.split('\n');
  const dataLines = lines.filter((l) => l.startsWith(DATA_PREFIX));
  if (dataLines.length === 0) return null;
  const joined = dataLines
    .map((l) => l.slice(DATA_PREFIX_LEN).trimStart())
    .join('\n')
    .trimEnd();
  if (joined.length === 0) return null;
  return joined;
}

export type FetchInit = {
  url: string;
  body: unknown;
  headers: Record<string, string>;
  signal?: AbortSignal;
};

/**
 * Thrown by `openSseConnection` when the upstream returns a non-OK status.
 * Carries the response body so callers can surface DeepSeek's `{error: {message, type, code}}` payloads.
 */
export class SseConnectionError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    public readonly body: string,
  ) {
    super(`SSE connection failed: ${status} ${statusText} — ${body || '<empty body>'}`);
    this.name = 'SseConnectionError';
  }
}

export async function openSseConnection(init: FetchInit): Promise<AsyncIterable<Uint8Array>> {
  const requestInit: RequestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...init.headers },
    body: JSON.stringify(init.body),
  };
  if (init.signal !== undefined) requestInit.signal = init.signal;

  const res = await fetch(init.url, requestInit);
  if (!res.ok || !res.body) {
    let body = '';
    try {
      body = res.body ? await res.text() : '';
    } catch {
      body = '<failed to read body>';
    }
    throw new SseConnectionError(res.status, res.statusText, body);
  }
  // Convert WHATWG ReadableStream → Node Readable (which implements AsyncIterable<Uint8Array>).
  return Readable.fromWeb(
    res.body as unknown as Parameters<typeof Readable.fromWeb>[0],
  ) as unknown as AsyncIterable<Uint8Array>;
}
