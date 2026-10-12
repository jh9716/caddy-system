import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { buildRosterExportXlsxBuffer } from "@/lib/caddyRosterExportXlsx";
import { requireAdmin, resolveAuthUser } from "@/lib/auth";
import { canReadArchivedCaddies } from "@/lib/caddyArchiveVisibility";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/caddies/export.xlsx — admin only
 * V2 Excel 템플릿 + 현재 명단. DB write 없음.
 *
 * RETIRED 포함은 기존 CSV export와 동일: 최고관리자(보관 조회)만.
 * phone는 관리자 전용 round-trip용 전체번호(phoneNormalized).
 */
export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard) return guard;

  try {
    const auth = await resolveAuthUser(req);
    const canReadArchived = canReadArchivedCaddies(auth);
    const rows = await prisma.caddy.findMany({
      select: {
        id: true,
        name: true,
        team: true,
        teamOrder: true,
        employmentStatus: true,
        phoneNormalized: true,
        thirdBandSubgroup: true,
        caddyType: true,
      },
      orderBy: [{ team: "asc" }, { teamOrder: "asc" }, { id: "asc" }],
    });

    const buffer = buildRosterExportXlsxBuffer(
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        team: r.team,
        teamOrder: r.teamOrder,
        employmentStatus: String(r.employmentStatus),
        phoneNormalized: r.phoneNormalized,
        thirdBandSubgroup: r.thirdBandSubgroup ?? null,
        caddyType: r.caddyType,
      })),
      { canReadArchived }
    );

    const stamp = new Date().toISOString().slice(0, 10);
    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="caddy-roster-${stamp}.xlsx"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "export 실패";
    console.error("[GET /api/caddies/export.xlsx]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
