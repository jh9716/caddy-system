import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { parseImportFile } from "@/lib/caddyImport";
import { buildXlsxV1SafePreview } from "@/lib/caddyRosterImportV1Safe";
import {
  buildRosterImportPreviewV2,
  detectExcelRosterFormat,
  parseRosterCsvV2,
  parseRosterXlsxV2,
} from "@/lib/caddyRosterImportV2";
import { requireAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function isExcelName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith(".xlsx") || lower.endsWith(".xls");
}

/**
 * POST multipart file 또는 JSON { csv, filename? }
 * DB 쓰기 없음 — preview만.
 * CSV → csv-v2 (id/teamOrder/employmentStatus/phone/thirdBandSubgroup)
 * 표 형식 XLSX/XLS → xlsx-v2 (첫 시트 → CSV v2와 동일한 검증 엔진)
 * 조 제목형 XLSX → xlsx-v1 (안전 반영 Preview. 파일 순서를 teamOrder로 쓰지 않음)
 */
export async function POST(req: NextRequest) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  try {
    const contentType = req.headers.get("content-type") || "";
    let filename = "import.csv";
    let buffer: Buffer | null = null;
    let csvText: string | null = null;

    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      if (!file || !(file instanceof File)) {
        return NextResponse.json({ error: "file 필요" }, { status: 400 });
      }
      filename = file.name || "import.csv";
      buffer = Buffer.from(await file.arrayBuffer());
    } else {
      const body = await req.json().catch(() => ({}));
      if (typeof body?.csv !== "string") {
        return NextResponse.json(
          { error: "csv 문자열 또는 file 업로드가 필요합니다." },
          { status: 400 }
        );
      }
      csvText = body.csv;
      filename = body.filename || "import.csv";
    }

    if (isExcelName(filename)) {
      if (!buffer) {
        return NextResponse.json(
          { error: "XLSX/XLS는 file 업로드가 필요합니다." },
          { status: 400 }
        );
      }

      const excelFormat = detectExcelRosterFormat(buffer);

      if (excelFormat === "xlsx-v2") {
        const existing = await prisma.caddy.findMany({
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
        const existingRows = existing.map((e) => ({
          id: e.id,
          name: e.name,
          team: e.team,
          teamOrder: e.teamOrder,
          employmentStatus: String(e.employmentStatus),
          phoneNormalized: e.phoneNormalized,
          thirdBandSubgroup: e.thirdBandSubgroup ?? null,
          caddyType: e.caddyType,
        }));
        const rows = parseRosterXlsxV2(buffer, filename);
        const preview = buildRosterImportPreviewV2(rows, existingRows);
        return NextResponse.json({ ...preview, format: "xlsx-v2" });
      }

      if (excelFormat === "xlsx-v1") {
        const rows = parseImportFile(buffer, filename);
        const existing = await prisma.caddy.findMany({
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
        const existingRows = existing.map((e) => ({
          id: e.id,
          name: e.name,
          team: e.team,
          teamOrder: e.teamOrder,
          employmentStatus: String(e.employmentStatus),
          phoneNormalized: e.phoneNormalized,
          thirdBandSubgroup: e.thirdBandSubgroup ?? null,
          caddyType: e.caddyType,
        }));
        const preview = buildXlsxV1SafePreview(rows, existingRows);
        return NextResponse.json(preview);
      }

      return NextResponse.json(
        {
          error:
            "이 Excel 파일은 표 형식 XLSX v2(Export CSV와 같은 컬럼)도, 조 제목형 XLSX v1도 아닙니다. 잘못된 형식을 v2로 변환하지 않습니다.",
        },
        { status: 400 }
      );
    }

    const existing = await prisma.caddy.findMany({
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
    const existingRows = existing.map((e) => ({
      id: e.id,
      name: e.name,
      team: e.team,
      teamOrder: e.teamOrder,
      employmentStatus: String(e.employmentStatus),
      phoneNormalized: e.phoneNormalized,
      thirdBandSubgroup: e.thirdBandSubgroup ?? null,
      caddyType: e.caddyType,
    }));

    const rows = parseRosterCsvV2(
      csvText ?? (buffer ? buffer.toString("utf8") : "")
    );
    const preview = buildRosterImportPreviewV2(rows, existingRows);
    return NextResponse.json(preview);
  } catch (e: any) {
    console.error("[POST /api/caddies/import/preview]", e?.message || e);
    return NextResponse.json(
      { error: e?.message || "preview 실패" },
      { status: 400 }
    );
  }
}
