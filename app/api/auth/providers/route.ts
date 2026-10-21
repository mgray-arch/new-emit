import { json } from "@/lib/http";
import { googleConfigured, microsoftConfigured } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Which sign-in buttons to show. Password is always on. Microsoft is optional. */
export async function GET() {
  return json({
    password: true,
    google: googleConfigured(),
    microsoft: microsoftConfigured(),
  });
}
