import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin, resolveAuthUser } from "@/lib/auth";
import { canReadArchivedCaddies } from "@/lib/caddyArchiveVisibility";
import { buildXlsxV2WorkbookPreview } from "@/lib/caddyRosterImportXlsxV2Preview";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_UPLOAD_BYTES = 2_000_000;

/**
 * POST /api/caddies/import-v2/xlsx/preview
 * V2 workbook DELTA preview. DB write 없음 (findMany only).
 * 적용은 POST /api/caddies/import-v2/xlsx/apply.
 */
export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard) return guard;

  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!file || !(file instanceof File)) {
      return NextResponse.json({ error: "file 필요" }, { status: 400 });
    }
    const filename = file.name || "roster.xlsx";
    if (!/\.xlsx$/i.test(filename)) {
      return NextResponse.json(
        { error: "P1 export.xlsx 형식(.xlsx)만 미리보기합니다." },
        { status: 400 }
      );
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        { error: "파일이 너무 큽니다. 2MB 이하만 올립니다." },
        { status: 400 }
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());
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

    const preview = buildXlsxV2WorkbookPreview(
      buffer,
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

    return NextResponse.json(preview);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "preview 실패";
    console.error("[POST /api/caddies/import-v2/xlsx/preview]", message);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
