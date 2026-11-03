/**
 * Who may sign in, and through which provider.
 * EMIT staff and Select staff use email and password. Microsoft Entra is optional and not required.
 * Receivers do not sign in. They open a private link.
 * Select admins are the addresses in SELECT_ADMIN_EMAILS. They are not EMIT users.
 * An EMIT admin is a portal role a Select admin sets on the Users page. It is not an identity-provider role.
 */

export type SignInRole = "customer" | "admin";

export interface AllowedIdentity {
  ok: true;
  role: SignInRole;
  email: string;
}

export interface RejectedIdentity {
  ok: false;
  error: string;
}

export type IdentityDecision = AllowedIdentity | RejectedIdentity;

export function adminEmails(): string[] {
  return splitList(process.env.SELECT_ADMIN_EMAILS || "mgray@goselect.com,dmartin@goselect.com");
}

export function selectDomain(): string {
  return (process.env.GOOGLE_HOSTED_DOMAIN || "goselect.com").trim().toLowerCase();
}

export function emitDomains(): string[] {
  return splitList(process.env.EMIT_EMAIL_DOMAINS || "emit.example,emit.com,emittechnologies.com");
}

export function emitAllowedEmails(): string[] {
  return splitList(process.env.EMIT_ALLOWED_EMAILS || "");
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function domainOf(email: string): string {
  return email.split("@")[1] || "";
}

function isSelectEmail(email: string): boolean {
  return adminEmails().includes(email) || domainOf(email) === selectDomain();
}

function isEmitStaff(email: string): boolean {
  return emitAllowedEmails().includes(email) || emitDomains().includes(domainOf(email));
}

/** An address a Select admin may turn into an EMIT password user. Never a Select admin. */
export function canProvisionEmitUser(email: string): IdentityDecision {
  const normalized = email.trim().toLowerCase();
  if (!normalized.includes("@")) return { ok: false, error: "Enter an email address." };
  if (isSelectEmail(normalized)) {
    return { ok: false, error: "Select staff sign in with email and password. Add them under Select staff, not as an EMIT user." };
  }
  if (!isEmitStaff(normalized)) {
    return {
      ok: false,
      error: "That email is not an EMIT staff address. Add the domain to EMIT_EMAIL_DOMAINS or the address to EMIT_ALLOWED_EMAILS.",
    };
  }
  return { ok: true, role: "customer", email: normalized };
}

/** Microsoft (Entra ID). EMIT staff only. Never grants Select admin or a receiver. */
export function identityFromMicrosoft(email: string): IdentityDecision {
  const normalized = email.trim().toLowerCase();
  if (!normalized.includes("@")) {
    return { ok: false, error: "Microsoft did not return an email address." };
  }
  if (isSelectEmail(normalized)) {
    return { ok: false, error: "Select staff sign in with email and password, not Microsoft." };
  }
  if (isEmitStaff(normalized)) return { ok: true, role: "customer", email: normalized };
  return {
    ok: false,
    error: "This Microsoft account is not an EMIT staff user. Receivers use the private link from Select and do not sign in.",
  };
}

