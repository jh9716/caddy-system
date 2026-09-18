/**
 * Admin search for 1-person test push targets.
 * Empty query → []. Max 20. No endpoint/keys.
 */
import type { PrismaClient } from "@prisma/client";

export const PUSH_TEST_SEARCH_LIMIT = 20;

export type PushTestTarget = {
  userId: number;
  caddyId: number | null;
  name: string;
  team: string;
  role: string;
  subscriptionCount: number;
};

export function normalizePushTestQuery(raw: unknown): string {
  return String(raw ?? "")
    .replace(/\u00a0/g, " ")
    .trim();
}

export function matchesPushTestQuery(q: string, name: string, team: string): boolean {
  const needle = q.toLowerCase();
  if (!needle) return false;
  return name.toLowerCase().includes(needle) || team.toLowerCase().includes(needle);
}

export async function searchPushTestTargets(
  db: PrismaClient,
  rawQuery: unknown
): Promise<PushTestTarget[]> {
  const q = normalizePushTestQuery(rawQuery);
  if (!q) return [];

  const rows = await db.user.findMany({
    where: {
      role: { in: ["caddy", "leader"] },
      caddy: {
        is: {
          employmentStatus: { not: "RETIRED" },
        },
      },
    },
    select: {
      id: true,
      role: true,
      caddyId: true,
      caddy: { select: { name: true, team: true } },
      pushSubscriptions: {
        where: { enabled: true },
        select: { id: true },
      },
    },
    orderBy: { id: "asc" },
    take: 400,
  });

  const hits: PushTestTarget[] = [];
  for (const row of rows) {
    const name = row.caddy?.name ?? "";
    const team = row.caddy?.team ?? "";
    if (!matchesPushTestQuery(q, name, team)) continue;
    hits.push({
      userId: row.id,
      caddyId: row.caddyId,
      name,
      team,
      role: row.role,
      subscriptionCount: row.pushSubscriptions.length,
    });
    if (hits.length >= PUSH_TEST_SEARCH_LIMIT) break;
  }
  return hits;
}
