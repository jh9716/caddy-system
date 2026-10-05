import type { Prisma, PrismaClient } from "@prisma/client";
import {
  buildDashboardAccountLinkSummary,
  type DashboardAccountLinkSummary,
} from "@/lib/adminCaddyLinkSummary";

type DbClient = PrismaClient | Prisma.TransactionClient;

/**
 * ACTIVE 캐디 전체 계정 상태를 고정 3쿼리로 만든다. 캐디별 조회 없음.
 */
export async function loadDashboardAccountLinkSummary(
  db: DbClient
): Promise<DashboardAccountLinkSummary> {
  const [caddies, linked, pending] = await Promise.all([
    db.caddy.findMany({
      where: { employmentStatus: "ACTIVE" },
      select: { id: true },
    }),
    db.user.findMany({
      where: { caddyId: { not: null } },
      select: { caddyId: true, username: true },
    }),
    db.caddyLinkRequest.findMany({
      where: { status: "PENDING" },
      select: {
        candidateCaddyIds: true,
        user: { select: { username: true } },
      },
    }),
  ]);

  return buildDashboardAccountLinkSummary({
    activeCaddyIds: caddies.map((c) => c.id),
    linked,
    pending: pending.map((row) => ({
      candidateCaddyIds: row.candidateCaddyIds,
      username: row.user.username,
    })),
  });
}
