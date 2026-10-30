import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { isSession, rejectIfViewingAs, requireSession } from "@/lib/guard";
import { errorResponse, forbidden, json, PortalError, unauthorized } from "@/lib/http";
import { canUploadPhotos } from "@/lib/types";
import { ingestCarrierPhoto, type IngestPhotoInput } from "@/lib/photos";
import { readyPortal } from "@/lib/portal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const photoJsonSchema = z.object({
  loadNumber: z.string().trim().min(1).max(40),
  source: z.string().trim().min(1).max(200),
  receivedAt: z.string().datetime({ offset: true }),
  filename: z.string().trim().min(1).max(120),
  contentType: z.string().trim().max(80).optional(),
  subject: z.string().trim().max(500).optional(),
  dataBase64: z.string().trim().min(1).max(18_000_000),
});

function tokenMatches(presented: string, expected: string): boolean {
  const actual = Buffer.from(presented);
  const wanted = Buffer.from(expected);
  if (actual.length !== wanted.length) {
    timingSafeEqual(wanted, wanted);
    return false;
  }
  return timingSafeEqual(actual, wanted);
}

async function authorize(req: Request): Promise<Response | null> {
  const header = req.headers.get("authorization") ?? "";
  if (header.toLowerCase().startsWith("bearer ")) {
    const expected = process.env.CARRIER_PHOTO_INGEST_TOKEN ?? "";
    const presented = header.slice(7).trim();
    if (expected.length >= 16 && tokenMatches(presented, expected)) return null;
    return unauthorized();
  }
  const session = await requireSession(req);
  if (!isSession(session)) return session;
  const readonly = rejectIfViewingAs(session);
  if (readonly) return readonly;
  if (!canUploadPhotos(session)) return forbidden();
  return null;
}

function decodeBase64(value: string): Uint8Array {
  const trimmed = value.trim().replace(/^data:[^,]+,/, "");
  if (!trimmed) throw new PortalError("Image data is empty");
  return new Uint8Array(Buffer.from(trimmed, "base64"));
}

async function readInput(req: Request): Promise<IngestPhotoInput> {
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    const body = photoJsonSchema.parse(await req.json());
    return {
      loadNumber: body.loadNumber,
      source: body.source,
      receivedAt: body.receivedAt,
      filename: body.filename,
      subject: body.subject,
      declaredType: body.contentType,
      bytes: decodeBase64(body.dataBase64),
    };
  }
  if (type.includes("multipart/form-data")) {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new PortalError("Choose an image to upload");
    const receivedAt = String(form.get("receivedAt") ?? "");
    const parsed = z.string().datetime({ offset: true }).safeParse(receivedAt);
    if (!parsed.success) throw new PortalError("receivedAt must be an ISO-8601 timestamp with a timezone");
    return {
      loadNumber: String(form.get("loadNumber") ?? ""),
      source: String(form.get("source") ?? ""),
      receivedAt: parsed.data,
      filename: file.name,
      subject: String(form.get("subject") ?? "") || null,
      declaredType: file.type,
      bytes: new Uint8Array(await file.arrayBuffer()),
    };
  }
  throw new PortalError("Send JSON or multipart form data.", 415);
}

export async function POST(req: Request) {
  try {
    const denied = await authorize(req);
    if (denied) return denied;
    const input = await readInput(req);
    const ctx = await readyPortal();
    const result = await ingestCarrierPhoto(ctx, input);
    return json(
      {
        id: result.id,
        loadNumber: result.loadNumber,
        sha256: result.sha256,
        mediaType: result.mediaType,
        source: result.source,
        receivedAt: result.receivedAt,
        duplicate: result.duplicate,
        visibleToCustomer: result.visibleToCustomer,
        heldReason: result.heldReason,
      },
      result.duplicate ? 200 : 201,
    );
  } catch (error) {
    return errorResponse(error);
  }
}
