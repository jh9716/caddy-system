/**
 * Web Push VAPID env. Public key only is ever returned to the client.
 * Private key is never imported into client bundles, never logged, never sent.
 * Send/web-push is out of scope for V1.
 */

export const WEB_PUSH_VAPID_PUBLIC_KEY_ENV = "WEB_PUSH_VAPID_PUBLIC_KEY";
export const WEB_PUSH_VAPID_PRIVATE_KEY_ENV = "WEB_PUSH_VAPID_PRIVATE_KEY";
export const WEB_PUSH_SUBJECT_ENV = "WEB_PUSH_SUBJECT";

const MAX_PUBLIC_KEY_CHARS = 256;

function readEnv(name: string): string {
  return String(process.env[name] ?? "").trim();
}

/** URL-safe base64 (with or without padding) → bytes. Invalid → null. */
export function decodeUrlSafeBase64(input: string): Uint8Array | null {
  const raw = String(input ?? "").trim();
  if (!raw || raw.length > MAX_PUBLIC_KEY_CHARS) return null;
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(raw)) return null;
  const pad = raw.length % 4 === 0 ? "" : "=".repeat(4 - (raw.length % 4));
  const b64 = raw.replace(/-/g, "+").replace(/_/g, "/") + pad;
  try {
    const buf = Buffer.from(b64, "base64");
    if (!buf.length) return null;
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

/** Uncompressed P-256 point (0x04 + 32 + 32). */
export function isUncompressedP256PublicKey(bytes: Uint8Array | null): boolean {
  return Boolean(bytes && bytes.length === 65 && bytes[0] === 0x04);
}

export function readVapidPublicKey(): string | null {
  const raw = readEnv(WEB_PUSH_VAPID_PUBLIC_KEY_ENV);
  if (!raw) return null;
  const bytes = decodeUrlSafeBase64(raw);
  if (!isUncompressedP256PublicKey(bytes)) return null;
  return raw;
}

export function isWebPushConfigured(): boolean {
  return readVapidPublicKey() != null;
}

/**
 * Status payload for GET. Never includes private key, endpoint, or auth keys.
 */
export function vapidClientConfig(): {
  configured: boolean;
  vapidPublicKey: string | null;
} {
  const vapidPublicKey = readVapidPublicKey();
  return {
    configured: vapidPublicKey != null,
    vapidPublicKey,
  };
}
