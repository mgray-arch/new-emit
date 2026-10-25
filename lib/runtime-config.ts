import type { PortalContext } from "@/lib/db";
import { demoSeedEnabled } from "@/lib/db";

const AUTH_SECRET_MESSAGE =
  "AUTH_SECRET is missing or shorter than 16 characters. In Vercel, open the project, then Settings, then Environment Variables. Add AUTH_SECRET for Preview (at least 16 characters) and redeploy.";

const TURSO_MESSAGE =
  "The preview database is not configured. In Vercel, add TURSO_DATABASE_URL and TURSO_AUTH_TOKEN for Preview. Use a new Turso database, not the production one, then redeploy.";

const DEMO_SEED_MESSAGE =
  "DEMO_SEED is not true on this preview, so the test account is not created. In Vercel, set DEMO_SEED to true for Preview only, on its own Turso database, then redeploy. Sign in as m.gray@emit.example with the demo password.";

const EMPTY_DATABASE_MESSAGE =
  "This database has no accounts. On the preview, set DEMO_SEED to true for a separate Turso database (not production) and redeploy. Then sign in as m.gray@emit.example with the demo password.";

/** Problems that stop sign-in until the deployment is configured. */
export function blockingSetupError(): string | null {
  const problems: string[] = [];
  if ((process.env.AUTH_SECRET ?? "").length < 16) problems.push(AUTH_SECRET_MESSAGE);
  if (process.env.VERCEL && !process.env.TURSO_DATABASE_URL?.trim()) problems.push(TURSO_MESSAGE);
  if (process.env.TURSO_DATABASE_URL?.trim().startsWith("libsql:") && !process.env.TURSO_AUTH_TOKEN?.trim()) {
    problems.push(TURSO_MESSAGE);
  }
  return problems.length ? problems.join(" ") : null;
}

/** Shown on the sign-in page. Includes blockers and preview seed warnings. */
export function setupNotices(): string[] {
  const notices: string[] = [];
  const blocking = blockingSetupError();
  if (blocking) notices.push(blocking);
  if (process.env.VERCEL_ENV === "preview" && !demoSeedEnabled()) notices.push(DEMO_SEED_MESSAGE);
  if (process.env.VERCEL_ENV === "production" && demoSeedEnabled()) {
    notices.push("DEMO_SEED is true on Production. Set it to false so demo accounts are not written into the live database.");
  }
  return notices;
}

export function setupFailureMessage(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const text = error.message;
  if (text.includes("AUTH_SECRET")) return AUTH_SECRET_MESSAGE;
  if (text.includes("TURSO")) return TURSO_MESSAGE;
  return null;
}

/** An empty non-production database is a setup miss, not a wrong password. */
export async function emptyAccountMessage(ctx: PortalContext): Promise<string | null> {
  if (process.env.VERCEL_ENV === "production") return null;
  const row = await ctx.db.prepare(`SELECT COUNT(*) AS n FROM users`).get();
  if (Number(row?.n ?? 0) > 0) return null;
  return EMPTY_DATABASE_MESSAGE;
}
