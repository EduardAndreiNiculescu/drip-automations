/** E-mail helpers that only break in production. */

const enc = new TextEncoder();

async function hmac(secret: string, message: string): Promise<string> {
  if (!secret || secret.length < 32) throw new Error("opt-out secret missing or shorter than 32 characters");
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
  return [...mac.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * One-click unsubscribe token, keyed on the e-mail (an unsubscribe click has
 * no session). An HMAC with a required secret: a hard-coded fallback salt
 * would let anyone unsubscribe anyone.
 */
export const optOutToken = (email: string, secret: string) => hmac(secret, `optout:${email.trim().toLowerCase()}`);

export async function verifyOptOut(email: string, token: string, secret: string): Promise<boolean> {
  const expected = await optOutToken(email, secret);
  if (token.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) diff |= token.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

/**
 * Makes a URL safe inside an `href` of an e-mail that will travel as
 * quoted-printable. QP treats `=XX` as an escaped byte, so a token like
 * `...&token=d5a1` can arrive as `...&token�a1` and the link dies. Encoding
 * `&` and `=` as HTML entities survives transport, and the browser decodes
 * them before navigating.
 */
export function hrefSafe(url: string): string {
  return url.replace(/&/g, "&amp;").replace(/=/g, "&#61;");
}

/** RFC 8058 headers so Gmail and Outlook show their native "Unsubscribe" button. */
export function listUnsubscribeHeaders(url: string, mailto?: string): Record<string, string> {
  return {
    "List-Unsubscribe": [mailto ? `<mailto:${mailto}>` : null, `<${url}>`].filter(Boolean).join(", "),
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}
