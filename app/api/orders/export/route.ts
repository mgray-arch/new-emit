import { presentCustomerOrder } from "@/lib/customer-view";
import { errorResponse } from "@/lib/http";
import { isSession, requireSession } from "@/lib/guard";
import { LOAD_TABS, loadsToCsv, type LoadTab } from "@/lib/load-list";
import { listOrders } from "@/lib/orders";
import { readyPortal } from "@/lib/portal";
import type { PortalStatus } from "@/lib/types";
import { PORTAL_STATUSES, canSeePricing } from "@/lib/types";

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
    const tab: LoadTab = (LOAD_TABS as readonly string[]).includes(tabParam || "") ? (tabParam as LoadTab) : "history";
    const page = await listOrders(ctx, {
      q: url.searchParams.get("q") || undefined,
      status: status && (PORTAL_STATUSES as readonly string[]).includes(status) ? (status as PortalStatus) : null,
      shipFrom: url.searchParams.get("shipFrom"),
      shipTo: url.searchParams.get("shipTo"),
      pickup: url.searchParams.get("pickup"),
      receiverCompany: url.searchParams.get("receiver"),
      tab,
      grouped: true,
      exportAll: true,
      page: 1,
      pageSize: 5000,
    });
    const includePricing = canSeePricing(session);
    const csv = loadsToCsv(
      page.orders.map((order) => presentCustomerOrder(order, session)),
      includePricing,
    );
    return new Response(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="loads.csv"',
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
