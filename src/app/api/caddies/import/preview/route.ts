import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { buildImportPreview, parseImportFile } from "@/lib/caddyImport";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function assertAdmin(req: NextRequest) {
  const role = req.cookies.get("role")?.value;
  if (role !== "admin") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

/**
 * POST multipart file (csv) 또는 JSON { csv: string }
 * DB 쓰기 없음 — preview만.
 * phone 컬럼이 있으면 masked 필드 + applyPayload(normalized)만 노출.
 */
export async function POST(req: NextRequest) {
  const denied = assertAdmin(req);
  if (denied) return denied;

  try {
    const contentType = req.headers.get("content-type") || "";
    let rows;

    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      if (!file || !(file instanceof File)) {
        return NextResponse.json({ error: "file 필요" }, { status: 400 });
      }
      const buf = Buffer.from(await file.arrayBuffer());
      rows = parseImportFile(buf, file.name || "import.csv");
    } else {
      const body = await req.json().catch(() => ({}));
      if (typeof body?.csv !== "string") {
        return NextResponse.json(
          { error: "csv 문자열 또는 file 업로드가 필요합니다." },
          { status: 400 }
        );
      }
      rows = parseImportFile(body.csv, body.filename || "import.csv");
    }

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
    return NextResponse.json(preview);
  } catch (e: any) {
    console.error("[POST /api/caddies/import/preview]", e?.message || e);
    return NextResponse.json(
      { error: e?.message || "preview 실패" },
      { status: 400 }
    );
  }
}
