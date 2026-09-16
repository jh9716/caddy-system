import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin, resolveAuthUser } from "@/lib/auth";
import {
  canReadArchivedCaddies,
  caddyManageListWhere,
} from "@/lib/caddyArchiveVisibility";
import { caddySearchApiResponse } from "@/lib/caddySearch";

export const dynamic = "force-dynamic";

/** Prisma에서 검색에 필요한 필드만. memo/extraFlags 등 전체 row 금지. */
const SEARCH_SELECT = {
  id: true,
  name: true,
  team: true,
  teamOrder: true,
  caddyType: true,
  employmentStatus: true,
  phoneNormalized: true,
} as const;

/**
 * GET /api/caddies/search?q=...
 * 관리자 전용 통합검색. 빈 q는 전체 roster를 내리지 않는다.
 * 응답에 phoneNormalized 키를 넣지 않는다.
 */
export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard) return guard;

  const q = String(req.nextUrl.searchParams.get("q") ?? "")
    .replace(/\u00a0/g, " ")
    .trim();
  if (!q) {
    return NextResponse.json({ results: [] });
  }

  try {
    const auth = await resolveAuthUser(req);
    const canReadArchived = canReadArchivedCaddies(auth);
    const where = caddyManageListWhere("all", canReadArchived);
    if ("empty" in where && where.empty) {
      return NextResponse.json({ results: [] });
    }

    const rows = await prisma.caddy.findMany({
      where,
      select: SEARCH_SELECT,
      orderBy: [{ team: "asc" }, { teamOrder: "asc" }, { id: "asc" }],
    });
    return NextResponse.json(caddySearchApiResponse(rows, q));
  } catch (e: unknown) {
    console.error("GET /api/caddies/search error");
    const message = e instanceof Error ? e.message : "검색 실패";
    return NextResponse.json({ error: message || "검색 실패" }, { status: 500 });
  }
}
