/**
 * Firebase Admin / FCM HTTP v1 service-account env.
 * Never logs project id, email, or private key (value, length, or excerpt).
 */

export type FcmServiceAccount = {
  projectId: string;
  clientEmail: string;
  privateKey: string;
};

const BEGIN_PKCS8 = "-----BEGIN PRIVATE KEY-----";
const END_PKCS8 = "-----END PRIVATE KEY-----";
const BEGIN_RSA = "-----BEGIN RSA PRIVATE KEY-----";
const END_RSA = "-----END RSA PRIVATE KEY-----";

function stripWrappingQuotes(raw: string): string {
  const t = raw.trim();
  if (t.length >= 2) {
    const a = t[0];
    const b = t[t.length - 1];
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) {
      return t.slice(1, -1);
    }
  }
  return t;
}

/** Vercel may store real newlines or the two-character sequence \\n. */
export function normalizeFirebasePrivateKey(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let key = stripWrappingQuotes(raw);
  if (!key) return null;
  key = key.replace(/\\n/g, "\n").replace(/\r\n/g, "\n").trim();
  const pkcs8 = key.includes(BEGIN_PKCS8) && key.includes(END_PKCS8);
  const rsa = key.includes(BEGIN_RSA) && key.includes(END_RSA);
  if (!pkcs8 && !rsa) return null;
  return key;
}

export function readFcmServiceAccount(
  env: NodeJS.ProcessEnv = process.env
): FcmServiceAccount | null {
  const projectId = String(env.FIREBASE_PROJECT_ID ?? "").trim();
  const clientEmail = String(env.FIREBASE_CLIENT_EMAIL ?? "").trim();
  const privateKey = normalizeFirebasePrivateKey(env.FIREBASE_PRIVATE_KEY);
  if (!projectId || !clientEmail || !privateKey) return null;
  if (!clientEmail.includes("@")) return null;
  return { projectId, clientEmail, privateKey };
}

export function isFcmServerConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return readFcmServiceAccount(env) != null;
}

export function isFcmSendEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.FCM_SEND_ENABLED === "1";
}

export function canAttemptNativePushSend(
  options?: { sendFn?: unknown },
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (options?.sendFn) return true;
  return isFcmSendEnabled(env) && isFcmServerConfigured(env);
}

export function hasPushDeliveryTargets(
  webCount: number,
  nativeCount: number
): boolean {
  return webCount > 0 || nativeCount > 0;
}
