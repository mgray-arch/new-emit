/**
 * Who may sign in, and through which provider.
 * EMIT staff use email and password. Microsoft Entra is optional and not required.
 * Select admins use Google. Receivers do not sign in. They open a private link.
 * The only admins are the Select addresses in SELECT_ADMIN_EMAILS.
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
    return { ok: false, error: "Select staff sign in with Google. This page is for EMIT staff." };
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
    return { ok: false, error: "Select staff sign in with Google, not Microsoft." };
  }
  if (isEmitStaff(normalized)) return { ok: true, role: "customer", email: normalized };
  return {
    ok: false,
    error: "This Microsoft account is not an EMIT staff user. Receivers use the private link from Select and do not sign in.",
  };
}

/** Google Workspace. Only the two Select admins, and only @goselect.com. */
export function identityFromGoogle(input: {
  email: string;
  emailVerified: boolean;
  hostedDomain: string | null;
}): IdentityDecision {
  const normalized = input.email.trim().toLowerCase();
  if (!input.emailVerified) {
    return { ok: false, error: "Google did not confirm this email address." };
  }
  if (!normalized.endsWith(`@${selectDomain()}`)) {
    return { ok: false, error: "Select staff sign in with a goselect.com Google account." };
  }
  if (input.hostedDomain && input.hostedDomain.toLowerCase() !== selectDomain()) {
    return { ok: false, error: "This Google account is not in the Select Workspace." };
  }
  if (isEmitStaff(normalized)) {
    return { ok: false, error: "EMIT signs in with email and password, not Google." };
  }
  if (!adminEmails().includes(normalized)) {
    return { ok: false, error: "This Google account is not a Select portal admin." };
  }
  return { ok: true, role: "admin", email: normalized };
}
