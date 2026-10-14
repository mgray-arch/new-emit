import { errorResponse, json } from "@/lib/http";
import { isSession, requireSession } from "@/lib/guard";
import { listOrders, orderStats, submitOrder } from "@/lib/orders";
import { readyPortal } from "@/lib/portal";
import type { PortalStatus } from "@/lib/types";
import { PORTAL_STATUSES } from "@/lib/types";
import { orderInputSchema } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const session = await requireSession(req);
    if (!isSession(session)) return session;
    const ctx = await readyPortal();
    const url = new URL(req.url);
    const status = url.searchParams.get("status");
    const page = Number(url.searchParams.get("page") || "1");
    const orders = listOrders(ctx, {
      q: url.searchParams.get("q") || undefined,
      status: status && (PORTAL_STATUSES as readonly string[]).includes(status) ? (status as PortalStatus) : null,
      shipFrom: url.searchParams.get("shipFrom"),
      shipTo: url.searchParams.get("shipTo"),
      page: Number.isFinite(page) ? page : 1,
      pageSize: 8,
    });
    return json({
      ...orders,
      stats: orderStats(ctx),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(req: Request) {
  try {
    const session = await requireSession(req);
    if (!isSession(session)) return session;
    const ctx = await readyPortal();
    const input = orderInputSchema.parse(await req.json());
    const result = await submitOrder(ctx, input, session);
    return json(result, 201);
  } catch (error) {
    return errorResponse(error);
  }
}
