import { createTransport } from "nodemailer";

export interface OutboundEmail {
  to: string;
  subject: string;
  text: string;
}

export interface SmtpConfig {
  user: string;
  password: string;
  fromName: string;
  from: string;
}

export const SMTP_HOST = "smtp.gmail.com";
export const SMTP_PORT = 465;
const DEFAULT_FROM_NAME = "Select Transport";
const MIN_APP_PASSWORD_LENGTH = 16;

/** Google shows an app password in groups. Spaces are not part of the secret. */
export function normalizeAppPassword(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, "");
}

function safeFromName(value: string | undefined): string {
  const cleaned = (value ?? "").replace(/[\r\n<>"]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned || DEFAULT_FROM_NAME;
}

/**
 * Gmail SMTP only. A missing user, a user that is not an email, or an app
 * password shorter than 16 characters means nothing is sent.
 */
export function emailConfig(env: Record<string, string | undefined> = process.env): SmtpConfig | null {
  const user = env.SMTP_USER?.trim() ?? "";
  const password = normalizeAppPassword(env.SMTP_APP_PASSWORD);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user)) return null;
  if (password.length < MIN_APP_PASSWORD_LENGTH) return null;
  const fromName = safeFromName(env.SMTP_FROM_NAME);
  return { user, password, fromName, from: `${fromName} <${user}>` };
}

export function smtpTransportOptions(config: SmtpConfig) {
  return {
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: true,
    auth: { user: config.user, pass: config.password },
    connectionTimeout: 8_000,
    greetingTimeout: 8_000,
    socketTimeout: 8_000,
  };
}

/** Sends plain text through smtp.gmail.com:465. Returns false when mail is not configured or SMTP rejects it. */
export async function sendEmail(
  message: OutboundEmail,
  env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
  const config = emailConfig(env);
  if (!config) return false;
  try {
    const transport = createTransport(smtpTransportOptions(config));
    await transport.sendMail({
      from: config.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
    });
    return true;
  } catch {
    return false;
  }
}
