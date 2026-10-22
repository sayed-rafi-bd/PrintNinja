import { buildStack } from "./boot.js";
import { purgeExpiredSessions } from "./domain/auth/index.js";
import { purgeOldTombstones } from "./domain/sync/index.js";

// Process entry (REFACTORING.md section 5): build the stack, purge
// once, listen, and shut down cleanly — stop accepting, let in-flight
// requests finish, close the database, then exit. The stack itself
// lives in ./boot.js so the serverless entry (api/index.ts) shares
// the wiring without the timers, purges or listener.
const { app, config, deps, close } = await buildStack();

// Cleanup: once at startup, then hourly. Sessions past their TTL go, and
// tombstones older than the retention window go (their absence is what
// lets a stale cursor answer reset instead of silently missing deletes).
// No job queue — a timer in the process entry is the whole mechanism.
// buildApp stays schedule-free so tests never inherit timers. Serverless
// deployments run this from a scheduled job against /v2/internal/cleanup
// instead (see docs/RELEASE.md).
const purgedSessionsAtStartup = await purgeExpiredSessions(deps);
const purgedTombstonesAtStartup = await purgeOldTombstones(
  deps,
  new Date(),
  config.syncTombstoneDays,
);
app.log.info(
  { purgedSessionsAtStartup, purgedTombstonesAtStartup },
  "purged at startup",
);
const cleanupTimer = setInterval(() => {
  void runCleanup();
}, config.sessionCleanupMinutes * 60_000);
// The listener socket owns the process lifetime, not this timer: a
// wedged event loop should not be held open by cleanup alone, and a
// slow purge must not overlap the next tick.
cleanupTimer.unref?.();
let cleanupRunning = false;
async function runCleanup(): Promise<void> {
  if (cleanupRunning) {
    app.log.warn("cleanup still running; skipping this tick");
    return;
  }
  cleanupRunning = true;
  try {
    const [purgedSessions, purgedTombstones] = await Promise.all([
      purgeExpiredSessions(deps),
      purgeOldTombstones(deps, new Date(), config.syncTombstoneDays),
    ]);
    app.log.info(
      { purgedSessions, purgedTombstones },
      "periodic cleanup finished",
    );
  } catch (error: unknown) {
    app.log.error({ err: error }, "periodic cleanup failed");
  } finally {
    cleanupRunning = false;
  }
}
app.addHook("onClose", async () => {
  clearInterval(cleanupTimer);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, "shutting down");
    close()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        app.log.error({ err: error }, "error during shutdown");
        process.exit(1);
      });
  });
}

await app.listen({ port: config.port, host: config.host });
