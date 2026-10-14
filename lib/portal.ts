import { demoSeedEnabled, getPortalContext, type PortalContext } from "@/lib/db";
import { seedDemo } from "@/lib/seed";

type GlobalSeed = typeof globalThis & { __portalSeed?: Promise<void>; __portalTest?: PortalContext };

async function seedIfEmpty(ctx: PortalContext): Promise<void> {
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
  if (!g.__portalSeed) g.__portalSeed = seedIfEmpty(ctx);
  await g.__portalSeed;
  return ctx;
}
