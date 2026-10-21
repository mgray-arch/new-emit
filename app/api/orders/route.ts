import { presentCustomerOrder } from "@/lib/customer-view";
import { errorResponse, json } from "@/lib/http";
import { isSession, requireSession } from "@/lib/guard";
import { LOAD_TABS, type LoadTab } from "@/lib/load-list";
import { listBoard, submitOrder } from "@/lib/orders";
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
    const tabParam = url.searchParams.get("tab");
    const tab: LoadTab = (LOAD_TABS as readonly string[]).includes(tabParam || "") ? (tabParam as LoadTab) : "attention";
    const page = Number(url.searchParams.get("page") || "1");
    const pageSize = Number(url.searchParams.get("pageSize") || "25");
    const board = await listBoard(ctx, {
      q: url.searchParams.get("q") || undefined,
      status: status && (PORTAL_STATUSES as readonly string[]).includes(status) ? (status as PortalStatus) : null,
      shipFrom: url.searchParams.get("shipFrom"),
      shipTo: url.searchParams.get("shipTo"),
      pickup: url.searchParams.get("pickup"),
      receiverCompany: url.searchParams.get("receiver"),
      tab,
      page: Number.isFinite(page) ? page : 1,
      pageSize: Number.isFinite(pageSize) ? pageSize : 25,
    });
    return json({
      ...board,
      orders: board.orders.map((order) => presentCustomerOrder(order, session.role)),
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
    return json({ order: presentCustomerOrder(result.order, session.role) }, 201);
  } catch (error) {
    return errorResponse(error);
  }
}
