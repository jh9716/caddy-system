/**
 * Vercel Cron 인증. CRON_SECRET Bearer만 허용 (fail closed).
 * 두 production project가 각각 자기 CRON_SECRET으로 호출해도 됨.
 */

import { timingSafeEqual } from "node:crypto";

export function authorizeCronRequest(req: {
  headers: { get: (name: string) => string | null };
}): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers.get("authorization") || "";
  const expected = `Bearer ${secret}`;
  const a = Buffer.from(auth);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
