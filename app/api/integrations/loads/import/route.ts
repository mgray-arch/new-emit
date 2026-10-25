import { botKeyMatches, consumeBotUpload } from "@/lib/bot-documents";
import { IMPORT_BATCH_LIMIT, importSamLoads } from "@/lib/load-import";
import { errorResponse, json, PortalError, unauthorized } from "@/lib/http";
import { clientIp } from "@/lib/passwords";
import { readyPortal } from "@/lib/portal";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  dryRun: z.boolean({
    required_error: "Set dryRun to true or false.",
    invalid_type_error: "Set dryRun to true or false.",
  }),
  loads: z
    .array(z.unknown(), { required_error: "Send a loads array.", invalid_type_error: "Send a loads array." })
    .min(1, "Send at least one load.")
    .max(IMPORT_BATCH_LIMIT, `Send at most ${IMPORT_BATCH_LIMIT} loads per call.`),
});

export async function POST(req: Request) {
  try {
    const ctx = await readyPortal();
    const budget = await consumeBotUpload(ctx, clientIp(req));
    if (!budget.allowed) {
      return json({ error: "Too many requests. Try again shortly." }, 429, {
        "retry-after": String(budget.retryAfterSeconds),
      });
    }
    if (!botKeyMatches(req)) return unauthorized();
    const type = req.headers.get("content-type") ?? "";
    if (!type.includes("application/json")) throw new PortalError("Send JSON.", 415);
    let payload: unknown;
    try {
      payload = await req.json();
    } catch {
      throw new PortalError("Send JSON.");
    }
    const body = bodySchema.parse(payload);
    const result = await importSamLoads(ctx, { dryRun: body.dryRun, loads: body.loads });
    return json(result);
  } catch (error) {
    return errorResponse(error);
  }
}
