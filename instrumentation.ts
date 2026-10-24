/**
 * Run the database upgrade when a Node server starts, before the first Loads request.
 * openDatabase is idempotent: a second instance retries, then sees the finished schema.
 * The import stays inside the nodejs check so the edge bundle does not pull in SQLite.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    if (process.env.NEXT_PHASE === "phase-production-build") return;
    if (process.env.PORTAL_TEST_MODE === "1") return;
    try {
      const { readyPortal } = await import("@/lib/portal");
      await readyPortal();
    } catch (error) {
      console.error(error);
    }
  }
}
