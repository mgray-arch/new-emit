import { ZodError } from "zod";

export class PortalError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export function json(data: unknown, status = 200, extra?: HeadersInit): Response {
  const headers = new Headers(extra);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(data), { status, headers });
}

export function unauthorized(): Response {
  return json({ error: "Unauthorized" }, 401);
}

export function forbidden(): Response {
  return json({ error: "Forbidden" }, 403);
}

export function errorResponse(error: unknown): Response {
  if (error instanceof ZodError) {
    return json({ error: error.issues[0]?.message ?? "Invalid request" }, 400);
  }
  if (error instanceof PortalError) {
    return json({ error: error.message }, error.status);
  }
  console.error(error);
  return json({ error: "Something went wrong" }, 500);
}
