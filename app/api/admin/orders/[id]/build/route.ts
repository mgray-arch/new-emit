import { presentCustomerOrder } from "@/lib/customer-view";
import { isSession, requireAdmin } from "@/lib/guard";
import { errorResponse, json } from "@/lib/http";
import { requestLoadBuild } from "@/lib/load-builder";
import { readyPortal } from "@/lib/portal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireAdmin(req);
    if (!isSession(session)) return session;
    const { id } = await context.params;
    const ctx = await readyPortal();
    const order = await requestLoadBuild(ctx, id);
    const status = order.samBuildStatus === "failed" ? 502 : 200;
    return json({ order: presentCustomerOrder(order, "admin") }, status);
  } catch (error) {
    return errorResponse(error);
  }
}
