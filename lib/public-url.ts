/**
 * Origin used in tracking links and receiver links.
 * Set PORTAL_PUBLIC_URL to the custom domain (https://emit-select.com) in production.
 * VERCEL_URL is the deployment hostname, not the custom domain, so it is only a fallback.
 */
export function portalPublicUrl(): string {
  const explicit = process.env.PORTAL_PUBLIC_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");
  const productionHost = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (productionHost && process.env.VERCEL_ENV === "production") {
    return withHttps(productionHost);
  }
  const vercel = process.env.VERCEL_URL?.trim();
  if (!vercel) return "";
  return withHttps(vercel);
}

function withHttps(host: string): string {
  const trimmed = host.replace(/\/$/, "");
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return trimmed;
  return `https://${trimmed}`;
}

/** Browser origin for auth callbacks. PORTAL_PUBLIC_URL wins so the redirect matches the OAuth client. */
export function requestOrigin(req: Request): string {
  const configured = process.env.PORTAL_PUBLIC_URL?.trim();
  if (configured) return configured.replace(/\/$/, "");
  const forwardedHost = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || req.headers.get("host") || "localhost:3000";
  const protoHeader = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const proto = protoHeader || (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}
