/** Turn a stored Select load number into a SAM link. The template is not known yet, so it stays in env. */
export function samLoadUrl(loadNumber: string | null | undefined): string | null {
  if (!loadNumber) return null;
  const template = process.env.SAM_LOAD_URL_TEMPLATE?.trim() ?? "";
  if (!template.includes("{loadNumber}")) return null;
  const href = template.replaceAll("{loadNumber}", encodeURIComponent(loadNumber));
  try {
    const url = new URL(href);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.toString();
  } catch {
    return null;
  }
}
