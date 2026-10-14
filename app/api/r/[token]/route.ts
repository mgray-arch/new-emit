import { assertNoCarrierFields } from "@/lib/customer-view";
import { errorResponse, json } from "@/lib/http";
import { readyPortal } from "@/lib/portal";
import { receiverCompanyForToken, shipmentsForReceiver } from "@/lib/receivers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, context: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await context.params;
    const ctx = await readyPortal();
    const receiver = receiverCompanyForToken(ctx, token);
    if (!receiver) return json({ error: "This link is not valid." }, 404);
    const body = { company: receiver.company, loads: shipmentsForReceiver(ctx, receiver.company) };
    assertNoCarrierFields(body);
    return json(body);
  } catch (error) {
    return errorResponse(error);
  }
}
