import { demoSeedEnabled, getPortalContext, type PortalContext } from "@/lib/db";
import { backfillDropLocations } from "@/lib/locations";
import { seedDemo } from "@/lib/seed";

type GlobalSeed = typeof globalThis & { __portalSeed?: Promise<void>; __portalTest?: PortalContext };

export async function seedIfEmpty(ctx: PortalContext): Promise<void> {
  // Production stays empty even if DEMO_SEED was copied onto that environment.
  // Preview may seed, but only the database its own TURSO_DATABASE_URL points at.
  if (process.env.VERCEL_ENV === "production") return;
  const row = await ctx.db.prepare(`SELECT COUNT(*) AS n FROM users`).get();
  if (Number(row?.n ?? 0) > 0 || !demoSeedEnabled()) return;
  try {
    await seedDemo(ctx);
  } catch (error) {
    const again = await ctx.db.prepare(`SELECT COUNT(*) AS n FROM users`).get();
    if (Number(again?.n ?? 0) > 0) return;
    throw error;
  }
}

export async function readyPortal(): Promise<PortalContext> {
  const ctx = await getPortalContext();
  const g = globalThis as GlobalSeed;
  if (process.env.PORTAL_TEST_MODE === "1" && g.__portalTest) return ctx;
  if (!g.__portalSeed) {
    let pending!: Promise<void>;
    pending = seedIfEmpty(ctx)
      .then(() => backfillDropLocations(ctx))
      .catch((error: unknown) => {
        if (g.__portalSeed === pending) delete g.__portalSeed;
        throw error;
      });
    g.__portalSeed = pending;
  }
  await g.__portalSeed;
  return ctx;
}
