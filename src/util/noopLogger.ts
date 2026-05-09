// src/util/noopLogger.ts
import type { Logger } from './logger.js';

/**
 * Centralised no-op Logger for paths where a logger argument is required by
 * signature but real logging would itself be disruptive (tests, pre-Ink-mount
 * initialisation seams, optional-callback fallbacks).
 *
 * Production code paths MUST NOT default to this — silent telemetry is a
 * regression. The pre-Phase-22 surface (SporeRegistry, pinFile, etc.) now
 * requires a real Logger at the call signature level; this constant exists for
 * the narrow remaining cases where the caller genuinely has nothing to log to.
 */
export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  flush: async () => {},
};
