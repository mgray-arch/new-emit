import { answerQuestion } from "@/lib/assistant";
import { isSession, requireSession } from "@/lib/guard";
import { errorResponse, json } from "@/lib/http";
import { readyPortal } from "@/lib/portal";
import { accessScope } from "@/lib/receivers";
import { z } from "zod";

const bodySchema = z.object({ question: z.string().trim().min(2).max(1000) });

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const session = await requireSession(req);
    if (!isSession(session)) return session;
    const ctx = await readyPortal();
    const scope = accessScope(ctx, session);
    const body = bodySchema.parse(await req.json());
    const answer = await answerQuestion(ctx, body.question, scope);
    return json(answer);
  } catch (error) {
    return errorResponse(error);
  }
}
