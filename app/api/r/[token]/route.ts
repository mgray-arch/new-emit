import { errorResponse, json } from "@/lib/http";
import { readyPortal } from "@/lib/portal";
import { receiverPortal } from "@/lib/receivers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, context: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await context.params;
    const ctx = await readyPortal();
    const body = await receiverPortal(ctx, token);
    if (!body) return json({ error: "This link is not valid." }, 404);
    return json(body);
  } catch (error) {
    return errorResponse(error);
  }
}
