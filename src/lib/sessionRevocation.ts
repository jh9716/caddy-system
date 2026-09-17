/**
 * Session revocation helpers for existing User.sessionVersion.
 * No schema changes. User.caddyId is unique (0 or 1 linked User per Caddy).
 */
import type { Prisma, PrismaClient } from "@prisma/client";

export type SessionRevocationDb = PrismaClient | Prisma.TransactionClient;

export function employmentBecameRetired(
  previous: unknown,
  next: unknown
): boolean {
  const prev = String(previous ?? "")
    .trim()
    .toUpperCase();
  const nxt = String(next ?? "")
    .trim()
    .toUpperCase();
  return nxt === "RETIRED" && prev !== "RETIRED";
}

/**
 * Increment sessionVersion for the User linked to this Caddy (at most one).
 * Safe no-op when no User is linked.
 */
export async function incrementSessionVersionForCaddyLink(
  db: SessionRevocationDb,
  caddyId: number
): Promise<number> {
  if (!Number.isInteger(caddyId) || caddyId < 1) return 0;
  const result = await db.user.updateMany({
    where: { caddyId },
    data: { sessionVersion: { increment: 1 } },
  });
  return result.count;
}

/**
 * Run a Caddy write; if employment becomes RETIRED, bump linked User.sessionVersion
 * in the same transaction.
 */
export async function writeCaddyRevokingRetiredSessions<T>(
  db: PrismaClient,
  input: {
    caddyId: number;
    previousEmployment: unknown;
    nextEmployment: unknown;
    write: (tx: SessionRevocationDb) => Promise<T>;
  }
): Promise<T> {
  if (
    !employmentBecameRetired(input.previousEmployment, input.nextEmployment)
  ) {
    return input.write(db);
  }
  return db.$transaction(async (tx) => {
    const result = await input.write(tx);
    await incrementSessionVersionForCaddyLink(tx, input.caddyId);
    return result;
  });
}
