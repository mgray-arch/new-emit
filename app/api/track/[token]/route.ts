import { toPublicTracking } from "@/lib/customer-view";
import { json } from "@/lib/http";
import { getOrderByToken } from "@/lib/orders";
import { readyPortal } from "@/lib/portal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  if (!token || token.length < 16) return json({ error: "Tracking link not found" }, 404);
  const ctx = await readyPortal();
  const order = getOrderByToken(ctx, token);
  if (!order) return json({ error: "Tracking link not found" }, 404);
  return json(toPublicTracking(order));
}
