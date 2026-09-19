/**
 * Resolve the User.id that owns a PushSubscription.
 * DB sessions use session userId. Env-only admin (userId=null) may bind to
 * an existing admin User by exact username — same rule as comment compose.
 * Never first/min User. Never hardcoded id=1. Caddy/leader get no fallback.
 */
import { normalizeAppRole } from "@/lib/sessionCookies";

export type PushUserLookupDb = {
  user: {
    findUnique: (args: {
      where: { username: string };
      select: { id: true; username: true; role: true };
    }) => Promise<{ id: number; username: string; role: string } | null>;
  };
};

export async function resolvePushSubscriptionUserId(
  db: PushUserLookupDb,
  auth: {
    role: string | null | undefined;
    userId: number | null;
    username?: string | null;
  }
): Promise<number | null> {
  if (
    typeof auth.userId === "number" &&
    Number.isInteger(auth.userId) &&
    auth.userId > 0
  ) {
    return auth.userId;
  }
  if (normalizeAppRole(auth.role) !== "admin") return null;
  const username = String(auth.username ?? "").trim();
  if (!username) return null;
  const row = await db.user.findUnique({
    where: { username },
    select: { id: true, username: true, role: true },
  });
  if (!row || row.username !== username) return null;
  if (normalizeAppRole(row.role) !== "admin") return null;
  if (!Number.isInteger(row.id) || row.id <= 0) return null;
  return row.id;
}

export function isEnvOnlyNonAdmin(auth: {
  role: string | null | undefined;
  userId: number | null;
}): boolean {
  if (typeof auth.userId === "number" && Number.isInteger(auth.userId) && auth.userId > 0) {
    return false;
  }
  return normalizeAppRole(auth.role) !== "admin";
}
