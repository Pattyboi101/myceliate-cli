# docstore

A spore for searching and managing documents via an MCP server.

The platform manages the underlying MCP server lifecycle (node). You invoke high-level primitives; the platform speaks the wire protocol.

## Capabilities

- `docstore_search(query: string, limit?: number)` — Search for documents matching a query.
  - `query` (string): Search query string
  - `limit` (number): Maximum number of results

- `docstore_delete-document(id: string)` — Permanently delete a document by ID.
  - `id` (string): Document identifier

- `docstore_ping()` — Check server availability.

## Sensitive operations

The following tools require human approval before each call:
- `docstore_delete-document` — Permanently delete a document by ID.

<!-- MYCELIATE: AUTO-GENERATED ABOVE; user notes BELOW are preserved on --regenerate -->
