/**
 * ID/password login rate limit.
 * Postgres Audit.create then count — insert claims a slot before bcrypt
 * so a concurrent burst cannot all observe the same pre-insert count.
 * Key is IP + attempted username, not IP alone (office NAT).
 *
 * Policy (locked): 8 claims in 15 minutes may proceed to bcrypt.
 * The 9th claim (count > 8) is 429 + Retry-After without bcrypt.
 *
 * Failures stay in Audit and age out of the window. Success deletes only
 * that request's speculative claim, not prior PASSWORD_LOGIN_FAIL history.
 * Fail-open: Audit errors do not 500 or change the generic 401 shape.
 * Payload never stores password, hash, or session.
 */

import {
  clientIpFromRequest,
  rateLimitIp,
} from "@/lib/accountDeletionRequest";

export const PASSWORD_LOGIN_RATE_ACTION = "PASSWORD_LOGIN_FAIL";
export const PASSWORD_LOGIN_RATE_ENTITY = "Auth";
export const PASSWORD_LOGIN_RATE_LIMIT = 8;
export const PASSWORD_LOGIN_RATE_WINDOW_MS = 15 * 60 * 1000;
export const PASSWORD_LOGIN_USERNAME_MAX = 80;

export type PasswordLoginRateDb = {
  audit: {
    count: (args: {
      where: {
        action: string;
        ip: string;
        createdAt: { gte: Date };
        payload: { equals: { u: string } };
      };
    }) => Promise<number>;
    findFirst: (args: {
      where: {
        action: string;
        ip: string;
        createdAt: { gte: Date };
        payload: { equals: { u: string } };
      };
      orderBy: { createdAt: "asc" };
      select: { createdAt: true };
    }) => Promise<{ createdAt: Date } | null>;
    create: (args: {
      data: {
        action: string;
        entity: string;
        entityId: null;
        ip: string;
        payload: { u: string };
      };
      select: { id: true };
    }) => Promise<{ id: number }>;
    deleteMany: (args: {
      where:
        | {
            id: number;
            action: string;
          }
        | {
            action: string;
            ip: string;
            payload: { equals: { u: string } };
          };
    }) => Promise<{ count: number }>;
  };
};

export function normalizeLoginRateUsername(username: string): string {
  return String(username ?? "").trim().slice(0, PASSWORD_LOGIN_USERNAME_MAX);
}

export function loginRateIpFromRequest(req: {
  headers: { get(name: string): string | null };
}): string {
  return rateLimitIp(clientIpFromRequest(req.headers));
}

function keyWhere(ip: string, username: string, since?: Date) {
  return {
    action: PASSWORD_LOGIN_RATE_ACTION,
    ip,
    payload: { equals: { u: username } },
    ...(since ? { createdAt: { gte: since } } : {}),
  };
}

function retryAfterSecFromOldest(
  oldest: { createdAt: Date } | null,
  now: number
): number {
  return Math.max(
    1,
    Math.ceil(
      ((oldest?.createdAt.getTime() ?? now) +
        PASSWORD_LOGIN_RATE_WINDOW_MS -
        now) /
        1000
    )
  );
}

export async function readPasswordLoginRateLimit(
  db: PasswordLoginRateDb,
  input: { ip: string; username: string; now?: number }
): Promise<{ limited: boolean; retryAfterSec: number; count: number }> {
  const username = normalizeLoginRateUsername(input.username);
  if (!username) {
    return { limited: false, retryAfterSec: 0, count: 0 };
  }
  const now = input.now ?? Date.now();
  const since = new Date(now - PASSWORD_LOGIN_RATE_WINDOW_MS);
  try {
    const count = await db.audit.count({
      where: keyWhere(input.ip, username, since),
    });
    if (count < PASSWORD_LOGIN_RATE_LIMIT) {
      return { limited: false, retryAfterSec: 0, count };
    }
    const oldest = await db.audit.findFirst({
      where: keyWhere(input.ip, username, since),
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    });
    return {
      limited: true,
      retryAfterSec: retryAfterSecFromOldest(oldest, now),
      count,
    };
  } catch (e) {
    console.error("[passwordLoginRateLimit] read failed", e);
    return { limited: false, retryAfterSec: 0, count: 0 };
  }
}

export async function claimPasswordLoginAttempt(
  db: PasswordLoginRateDb,
  input: { ip: string; username: string; now?: number }
): Promise<{
  limited: boolean;
  retryAfterSec: number;
  count: number;
  claimId: number | null;
}> {
  const username = normalizeLoginRateUsername(input.username);
  if (!username) {
    return { limited: false, retryAfterSec: 0, count: 0, claimId: null };
  }
  const now = input.now ?? Date.now();
  const since = new Date(now - PASSWORD_LOGIN_RATE_WINDOW_MS);
  let claimId: number | null = null;
  try {
    const created = await db.audit.create({
      data: {
        action: PASSWORD_LOGIN_RATE_ACTION,
        entity: PASSWORD_LOGIN_RATE_ENTITY,
        entityId: null,
        ip: input.ip,
        payload: { u: username },
      },
      select: { id: true },
    });
    claimId = created.id;
  } catch (e) {
    console.error("[passwordLoginRateLimit] claim failed", e);
    return { limited: false, retryAfterSec: 0, count: 0, claimId: null };
  }
  try {
    const count = await db.audit.count({
      where: keyWhere(input.ip, username, since),
    });
    if (count <= PASSWORD_LOGIN_RATE_LIMIT) {
      return { limited: false, retryAfterSec: 0, count, claimId };
    }
    const oldest = await db.audit.findFirst({
      where: keyWhere(input.ip, username, since),
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    });
    return {
      limited: true,
      retryAfterSec: retryAfterSecFromOldest(oldest, now),
      count,
      claimId,
    };
  } catch (e) {
    console.error("[passwordLoginRateLimit] count after claim failed", e);
    return { limited: false, retryAfterSec: 0, count: 0, claimId };
  }
}

export async function releasePasswordLoginClaim(
  db: PasswordLoginRateDb,
  claimId: number | null
): Promise<void> {
  if (claimId == null) return;
  try {
    await db.audit.deleteMany({
      where: { id: claimId, action: PASSWORD_LOGIN_RATE_ACTION },
    });
  } catch (e) {
    console.error("[passwordLoginRateLimit] release claim failed", e);
  }
}

export async function recordPasswordLoginFailure(
  db: PasswordLoginRateDb,
  input: { ip: string; username: string }
): Promise<void> {
  const username = normalizeLoginRateUsername(input.username);
  if (!username) return;
  try {
    await db.audit.create({
      data: {
        action: PASSWORD_LOGIN_RATE_ACTION,
        entity: PASSWORD_LOGIN_RATE_ENTITY,
        entityId: null,
        ip: input.ip,
        payload: { u: username },
      },
      select: { id: true },
    });
  } catch (e) {
    console.error("[passwordLoginRateLimit] record failed", e);
  }
}

/** Test / maintenance cleanup only. Login success does not wipe history. */
export async function clearPasswordLoginFailures(
  db: PasswordLoginRateDb,
  input: { ip: string; username: string }
): Promise<void> {
  const username = normalizeLoginRateUsername(input.username);
  if (!username) return;
  try {
    await db.audit.deleteMany({
      where: keyWhere(input.ip, username),
    });
  } catch (e) {
    console.error("[passwordLoginRateLimit] clear failed", e);
  }
}
