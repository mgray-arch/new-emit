import { json } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Receivers never receive photo, POD, or BOL bytes. A valid token gets the same 404 as a dead one. */
export async function GET(_req: Request, _context: { params: Promise<{ token: string; photoId: string }> }) {
  return json({ error: "This link is not valid." }, 404);
}
