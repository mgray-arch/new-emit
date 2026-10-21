import { botKeyMatches, consumeBotUpload, ingestBotDocument, parseBotDocType, parseBotLoadNumber } from "@/lib/bot-documents";
import { errorResponse, json, PortalError, unauthorized } from "@/lib/http";
import { clientIp } from "@/lib/passwords";
import { readyPortal } from "@/lib/portal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function readMultipart(req: Request): Promise<{
  loadNumber: string;
  filename: string;
  bytes: Uint8Array;
  docType: ReturnType<typeof parseBotDocType>;
}> {
  const type = req.headers.get("content-type") ?? "";
  if (!type.includes("multipart/form-data")) throw new PortalError("Send multipart form data.", 415);
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) throw new PortalError("Choose a file to upload");
  const loadField = form.get("loadNumber") ?? form.get("load_number");
  const loadNumber = parseBotLoadNumber(typeof loadField === "string" ? loadField : "");
  const docField = form.get("doc_type") ?? form.get("docType");
  const docType = parseBotDocType(typeof docField === "string" ? docField : "");
  return {
    loadNumber,
    filename: file.name,
    bytes: new Uint8Array(await file.arrayBuffer()),
    docType,
  };
}

export async function POST(req: Request) {
  try {
    const ctx = await readyPortal();
    const budget = await consumeBotUpload(ctx, clientIp(req));
    if (!budget.allowed) {
      return json({ error: "Too many uploads. Try again shortly." }, 429, {
        "retry-after": String(budget.retryAfterSeconds),
      });
    }
    if (!botKeyMatches(req)) return unauthorized();
    const input = await readMultipart(req);
    const result = await ingestBotDocument(ctx, input);
    return json(result, result.duplicate ? 200 : 201);
  } catch (error) {
    return errorResponse(error);
  }
}
