export interface OutboundEmail {
  to: string;
  subject: string;
  text: string;
}

export interface EmailConfig {
  url: string;
  key: string;
  from: string;
}

const MIN_KEY_LENGTH = 16;

/**
 * Minimal mail sender. Resend accepts this body at https://api.resend.com/emails.
 * A missing key, a short key, or a missing from-address means nothing is sent.
 */
export function emailConfig(env: Record<string, string | undefined> = process.env): EmailConfig | null {
  const key = env.EMAIL_API_KEY?.trim() ?? "";
  const from = env.EMAIL_FROM?.trim() ?? "";
  const url = env.EMAIL_API_URL?.trim() || "https://api.resend.com/emails";
  if (key.length < MIN_KEY_LENGTH || !from) return null;
  if (!url.startsWith("https://") && !url.startsWith("http://")) return null;
  return { url, key, from };
}

export async function sendEmail(
  message: OutboundEmail,
  fetchImpl: typeof fetch = fetch,
  env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
  const config = emailConfig(env);
  if (!config) return false;
  const response = await fetchImpl(config.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.key}`,
    },
    body: JSON.stringify({
      from: config.from,
      to: [message.to],
      subject: message.subject,
      text: message.text,
    }),
    signal: AbortSignal.timeout(8_000),
  });
  return response.ok;
}
