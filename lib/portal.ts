import { demoSeedEnabled, getPortalContext, type PortalContext } from "@/lib/db";
import { seedDemo } from "@/lib/seed";

type GlobalSeed = typeof globalThis & { __portalSeed?: Promise<void>; __portalTest?: PortalContext };

export async function readyPortal(): Promise<PortalContext> {
  const ctx = getPortalContext();
  const g = globalThis as GlobalSeed;
  if (process.env.PORTAL_TEST_MODE === "1" && g.__portalTest) return ctx;
  if (!g.__portalSeed) {
    g.__portalSeed = (async () => {
      const row = ctx.db.prepare(`SELECT COUNT(*) AS n FROM users`).get() as { n: number };
      if (row.n === 0 && demoSeedEnabled()) await seedDemo(ctx);
    })();
  }
  await g.__portalSeed;
  return ctx;
}
