// Fixture: reads stdin then sleeps forever (for timeout test).
import { readFileSync } from 'node:fs';
// drain stdin so the parent doesn't block on stdin.end()
try {
  readFileSync('/dev/stdin');
} catch {
  /* ignore */
}
// sleep forever
setInterval(() => {}, 2_147_483_647);
