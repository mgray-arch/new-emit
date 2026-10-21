import { demoSeedEnabled } from "@/lib/db";
import { json } from "@/lib/http";
import { setupNotices } from "@/lib/runtime-config";
import { googleConfigured, microsoftConfigured } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request) {
  const showDemo = demoSeedEnabled() && process.env.NEXT_PUBLIC_DEMO_HINT !== "false";
  return json({
    password: true,
    google: googleConfigured(),
    microsoft: microsoftConfigured(),
    setup: setupNotices(),
    demoHint: showDemo
      ? {
          emit: "m.gray@emit.example",
          emitViewer: "viewer@emit.example",
          emitFull: "lead@emit.example",
          select: ["mgray@goselect.com", "dmartin@goselect.com"],
          password: process.env.DEMO_USER_PASSWORD || "Emit-Demo-2026",
        }
      : null,
  });
}
