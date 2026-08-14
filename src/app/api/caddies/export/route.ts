import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { buildRosterExportCsv } from "@/lib/caddyRosterImportV2";
import { requireAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/caddies/export — admin only
 * CSV: id,name,team,teamOrder,employmentStatus,phone
 *
 * phone는 관리자 전용 round-trip용 전체번호(phoneNormalized).
 * UI 목록 마스킹 정책과 별도로, admin GET /api/caddies 와 동일하게
 * 원문을 내려준다 (명단 재업로드에 필요).
 */
export async function GET(req: NextRequest) {
  const guard = requireAdmin(req);
  if (guard) return guard;

  try {
    const rows = await prisma.caddy.findMany({
      select: {
        id: true,
        name: true,
        team: true,
        teamOrder: true,
        employmentStatus: true,
        phoneNormalized: true,
      },
      orderBy: [{ team: "asc" }, { teamOrder: "asc" }, { id: "asc" }],
    });

    const csv = buildRosterExportCsv(
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        team: r.team,
        teamOrder: r.teamOrder,
        employmentStatus: String(r.employmentStatus),
        phoneNormalized: r.phoneNormalized,
      }))
    );

    const stamp = new Date().toISOString().slice(0, 10);
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="caddy-roster-${stamp}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e: any) {
    console.error("[GET /api/caddies/export]", e?.message || e);
    return NextResponse.json(
      { error: e?.message || "export 실패" },
      { status: 500 }
    );
  }
}
