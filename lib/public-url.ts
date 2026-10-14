/** Origin used in tracking links, receiver links, and confirmation emails. */
export function portalPublicUrl(): string {
  const explicit = process.env.PORTAL_PUBLIC_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");
  const vercel = process.env.VERCEL_URL?.trim();
  if (!vercel) return "";
  const host = vercel.replace(/\/$/, "");
  return host.startsWith("http://") || host.startsWith("https://") ? host : `https://${host}`;
}
