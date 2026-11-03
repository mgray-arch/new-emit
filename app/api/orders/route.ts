import { badgeForOrder, carrierEvents, seenMap, unseenLoadIds } from "@/lib/carrier-seen";
import { presentCustomerOrder } from "@/lib/customer-view";
import { errorResponse, json } from "@/lib/http";
import { isSession, requireSession } from "@/lib/guard";
import { LOAD_TABS, type LoadTab } from "@/lib/load-list";
import { listBoard, submitOrder } from "@/lib/orders";
import { readyPortal } from "@/lib/portal";
import type { CustomerOrder, PortalStatus, Session } from "@/lib/types";
import { PORTAL_STATUSES, resolveAccess } from "@/lib/types";
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
    const selectStaff = resolveAccess(session).select;
    const requested: LoadTab = (LOAD_TABS as readonly string[]).includes(tabParam || "")
      ? (tabParam as LoadTab)
      : selectStaff
        ? "attention"
        : "active";
    const page = Number(url.searchParams.get("page") || "1");
    const pageSize = Number(url.searchParams.get("pageSize") || "25");
    const updatedOnly = url.searchParams.get("updated") === "1";
    const [events, seen] = await Promise.all([carrierEvents(ctx), seenMap(ctx, session.userId)]);
    const unseen = unseenLoadIds(events, seen);
    const board = await listBoard(ctx, {
      q: url.searchParams.get("q") || undefined,
      status: status && (PORTAL_STATUSES as readonly string[]).includes(status) ? (status as PortalStatus) : null,
      shipFrom: url.searchParams.get("shipFrom"),
      shipTo: url.searchParams.get("shipTo"),
      pickup: url.searchParams.get("pickup"),
      receiverCompany: url.searchParams.get("receiver"),
      tab: requested,
      includeAttention: selectStaff,
      page: Number.isFinite(page) ? page : 1,
      pageSize: Number.isFinite(pageSize) ? pageSize : 25,
      ids: updatedOnly ? unseen : undefined,
      acrossTabs: updatedOnly,
    });
    return json({
      ...board,
      updatedCount: unseen.length,
      updatedOnly,
      orders: board.orders.map((order) => presentForUser(order, session, seen)),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

function presentForUser(order: CustomerOrder, session: Session, seen: Map<string, string>) {
  return presentCustomerOrder(order, session, { carrierBadge: badgeForOrder(order, seen) });
}

export async function POST(req: Request) {
  try {
    const session = await requireSession(req);
    if (!isSession(session)) return session;
    const ctx = await readyPortal();
    const input = orderInputSchema.parse(await req.json());
    const result = await submitOrder(ctx, input, session);
    return json({ order: presentCustomerOrder(result.order, session) }, 201);
  } catch (error) {
    return errorResponse(error);
  }
}
