import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { buildImportPreview, parseImportFile } from "@/lib/caddyImport";
import {
  buildRosterImportPreviewV2,
  parseRosterCsvV2,
} from "@/lib/caddyRosterImportV2";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function assertAdmin(req: NextRequest) {
  const role = req.cookies.get("role")?.value;
  if (role !== "admin") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

function isExcelName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith(".xlsx") || lower.endsWith(".xls");
}

/**
 * POST multipart file 또는 JSON { csv, filename? }
 * DB 쓰기 없음 — preview만.
 * CSV → Import v2 (id/teamOrder/employmentStatus/phone)
 * XLSX → 기존 v1 preview (team/name 레이아웃)
 */
export async function POST(req: NextRequest) {
  const denied = assertAdmin(req);
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
      const rows = parseImportFile(buffer, filename);
      const existing = await prisma.caddy.findMany({
        select: {
          id: true,
          name: true,
          team: true,
          status: true,
          phoneNormalized: true,
        },
        orderBy: { id: "asc" },
      });
      const preview = buildImportPreview(rows, existing);
      return NextResponse.json({ format: "xlsx-v1", ...preview });
    }

    const text =
      csvText ??
      (buffer ? buffer.toString("utf8") : "");
    const rows = parseRosterCsvV2(text);
    const existing = await prisma.caddy.findMany({
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
    const preview = buildRosterImportPreviewV2(
      rows,
      existing.map((e) => ({
        id: e.id,
        name: e.name,
        team: e.team,
        teamOrder: e.teamOrder,
        employmentStatus: String(e.employmentStatus),
        phoneNormalized: e.phoneNormalized,
      }))
    );
    return NextResponse.json(preview);
  } catch (e: any) {
    console.error("[POST /api/caddies/import/preview]", e?.message || e);
    return NextResponse.json(
      { error: e?.message || "preview 실패" },
      { status: 400 }
    );
  }
}
