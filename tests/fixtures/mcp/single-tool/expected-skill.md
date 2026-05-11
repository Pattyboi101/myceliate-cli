# fetcher

A spore that fetches web content via an MCP server.

The platform manages the underlying MCP server lifecycle (npx). You invoke high-level primitives; the platform speaks the wire protocol.

## Capabilities

- `fetcher_fetch(url: string)` — Fetch a URL and return its body content.
  - `url` (string): URL to fetch

<!-- MYCELIATE: AUTO-GENERATED ABOVE; user notes BELOW are preserved on --regenerate -->
