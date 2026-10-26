import { errorResponse, json } from "@/lib/http";
import { isSession, requireAdmin } from "@/lib/guard";
import { readyPortal } from "@/lib/portal";
import { createEmitUser, listEmitUsers } from "@/lib/users";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  email: z.string().trim().email().max(200),
  password: z.string().max(200).optional(),
  generatePassword: z.boolean().optional(),
  access: z.enum(["admin", "regular"]).optional(),
  permission: z.enum(["view", "add", "pricing", "full"]).optional(),
  chatEnabled: z.boolean().optional(),
});

export async function GET(req: Request) {
  try {
    const session = await requireAdmin(req);
    if (!isSession(session)) return session;
    const ctx = await readyPortal();
    return json({ users: await listEmitUsers(ctx) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(req: Request) {
  try {
    const session = await requireAdmin(req);
    if (!isSession(session)) return session;
    const body = createSchema.parse(await req.json());
    const ctx = await readyPortal();
    const result = await createEmitUser(ctx, body);
    return json(result, 201);
  } catch (error) {
    return errorResponse(error);
  }
}
