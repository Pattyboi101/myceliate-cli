const DONE_MARKER = '[DONE]';

export async function* parseSseStream(
  byteStream: AsyncIterable<Uint8Array>,
): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of byteStream) {
    buffer += decoder.decode(chunk, { stream: true });
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
  // Drain any final event if the stream closed without trailing \n\n.
  if (buffer.length > 0) {
    const payload = extractDataPayload(buffer);
    if (payload !== null && payload !== DONE_MARKER) yield payload;
  }
}

function extractDataPayload(event: string): string | null {
  const lines = event.split('\n');
  const dataLines = lines.filter((l) => l.startsWith('data:'));
  if (dataLines.length === 0) return null;
  return dataLines.map((l) => l.slice(5).trimStart()).join('\n');
}

export type FetchInit = {
  url: string;
  body: unknown;
  headers: Record<string, string>;
  signal?: AbortSignal;
};

export async function openSseConnection(init: FetchInit): Promise<AsyncIterable<Uint8Array>> {
  const requestInit: RequestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...init.headers },
    body: JSON.stringify(init.body),
  };
  if (init.signal !== undefined) {
    requestInit.signal = init.signal;
  }
  const res = await fetch(init.url, requestInit);
  if (!res.ok || !res.body) {
    throw new Error(`SSE connection failed: ${res.status} ${res.statusText}`);
  }
  return res.body as unknown as AsyncIterable<Uint8Array>;
}
