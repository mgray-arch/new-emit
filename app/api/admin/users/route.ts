import { isSession, requireAdmin } from "@/lib/guard";
import { errorResponse, json } from "@/lib/http";
import { readyPortal } from "@/lib/portal";
import { createEmitUser, listEmitUsers } from "@/lib/users";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createSchema = z.object({
  name: z.string().trim().min(1, "Name is required.").max(120),
  email: z.string().trim().email("Enter an email address.").max(200),
  password: z.string().min(10, "Use at least 10 characters.").max(200).optional(),
  generatePassword: z.boolean().optional(),
});

export async function GET(req: Request) {
  try {
    const session = await requireAdmin(req);
    if (!isSession(session)) return session;
    return json({ users: await listEmitUsers(await readyPortal()) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(req: Request) {
  try {
    const session = await requireAdmin(req);
    if (!isSession(session)) return session;
    const body = createSchema.parse(await req.json());
    const result = await createEmitUser(await readyPortal(), body);
    return json(result, 201);
  } catch (error) {
    return errorResponse(error);
  }
}
