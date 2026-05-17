// src/security/secretFileFilter.ts
//
// Shared filter for secret-adjacent filenames. Applied in two places:
// 1. `src/orchestrator/context.ts` `listDirEntries` — strips entries from the
//    system-prompt's "cwd entries:" injection so the LLM never sees secret
//    filenames as ground-truth context.
// 2. `src/tools/listDir.ts` `listDirTool.run` — strips entries from the
//    `list_dir` tool's result, so an execution sub-agent that calls the tool
//    directly cannot bypass the system-prompt filter and read secret-adjacent
//    filenames from a directory listing.
//
// Phase 16 review (MAJOR-1): the original Phase 16 plan applied the filter
// only at (1); the `list_dir` tool was a parallel R11 leak surface that
// shipped half-hardened. This module unifies the two callers so future
// additions to the safelist (.kdbx etc., v1.3 fast-follow) land once.
//
// Design notes:
// - Filename leakage (NAMES, not contents) is the threat model. Contents are
//   never disclosed by either caller — listDir returns names only.
// - Case-sensitive matching. Patrick's project targets Linux filesystems
//   (case-sensitive). On macOS APFS default-case-insensitive volumes,
//   `.ENV` would slip through. v1.3 may add a case-fold layer if we grow
//   cross-platform.
// - The `dot > 0` guard in isSecretFile correctly excludes both no-dot names
//   (lastIndexOf returns -1) AND leading-dot names like `.env` (returns 0)
//   from the extension check — those go through SECRET_FILE_NAMES exact
//   match instead. A name like `.foo.key` returns 4 from lastIndexOf, slices
//   to `.key`, and matches the extension set. ✓.
// - `name.startsWith('.env.')` is a prefix-match alongside the exact set so
//   environment-variant files like `.env.staging` / `.env.example` /
//   `.env.backup` are stripped without enumerating every variant.

const SECRET_FILE_NAMES = new Set([
  // Dotenv core + named environments.
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
  '.env.test',
  // Git internals.
  '.git',
  // Project-local agent state.
  '.myceliate',
  // SSH key pairs.
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  'id_dsa',
  // Generic credential stores commonly committed-by-accident.
  'secrets.json',
  'credentials',
  'credentials.json',
  // Phase 16 review m4: language/tool credential stores.
  '.npmrc', // npm auth tokens
  '.pypirc', // PyPI credentials
  '.netrc', // generic credential store
  '.pgpass', // PostgreSQL password file
]);

const SECRET_FILE_EXTENSIONS = new Set([
  // X.509 / TLS chain.
  '.key',
  '.pem',
  '.p12',
  '.pfx',
  '.cer',
  '.crt',
  '.der',
  // Phase 16 review m5: cryptographic archive formats.
  '.gpg', // GPG-encrypted blobs
  '.asc', // ASCII-armored GPG
  '.kdbx', // KeePass database
  '.jks', // Java KeyStore
  '.p8', // PKCS#8 private key (Apple, JWK contexts)
]);

export function isSecretFile(name: string): boolean {
  if (SECRET_FILE_NAMES.has(name)) return true;
  // `.env.*` prefix match — covers .env.staging, .env.ci, .env.example, .env.backup, etc.
  if (name.startsWith('.env.')) return true;
  const dot = name.lastIndexOf('.');
  if (dot > 0) {
    const ext = name.slice(dot);
    if (SECRET_FILE_EXTENSIONS.has(ext)) return true;
  }
  return false;
}

/** Filter helper for callers that want a one-shot pass over a list of names. */
export function filterSecretFiles(names: readonly string[]): string[] {
  return names.filter((n) => !isSecretFile(n));
}
