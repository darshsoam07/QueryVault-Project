/**
 * Nitro startup plugin: validate configuration before the listener serves.
 *
 * Registered explicitly by `nitro.plugins` in vite.config.ts, not auto-discovered
 * — Nitro v3 defaults `serverDir: false`, so nothing under `server/` is scanned.
 * It lives here anyway because this is Nitro's conventional location for exactly
 * this kind of file.
 *
 * It exists because of where Nitro puts things: the SSR entry (`src/server.ts`)
 * lands in a chunk that is imported lazily on the *first request*, so a check
 * there is not a boot check. Verified before this plugin existed: a container
 * with a cross-project Supabase key came up, logged "Listening", answered the
 * liveness probe 200, and then 500'd every page — reporting itself healthy while
 * serving nothing. Nitro plugins run during app initialisation, which is the
 * earliest point that is actually before traffic.
 *
 * Exiting rather than throwing is deliberate for production: an orchestrator
 * treats a process that exits non-zero as a failed task and rolls back or
 * restarts it, whereas an unhandled rejection can leave the process listening.
 * In development the error is rethrown instead, so the dev server surfaces it in
 * place rather than vanishing.
 */
import { ensureBootConfigChecked } from "../../src/lib/config/boot.server";

export default function configGuardPlugin(): void {
  try {
    ensureBootConfigChecked();
  } catch (error) {
    // assertBootConfig has already logged the findings by variable name.
    if (process.env["NODE_ENV"] !== "production") throw error;
    process.exit(1);
  }
}
