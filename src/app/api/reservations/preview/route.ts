import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { parseReservationWorkbook } from "@/lib/reservationImportXlsx";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST multipart file (xlsx/xls)
 * DB 쓰기 없음 — 예약표 파싱 preview만.
 */
export async function POST(req: NextRequest) {
  const guard = requireAdmin(req);
  if (guard) return guard;

  try {
    const contentType = req.headers.get("content-type") || "";
    if (!contentType.includes("multipart/form-data")) {
      return NextResponse.json(
        { error: "multipart file 업로드가 필요합니다." },
        { status: 400 }
      );
    }

    const form = await req.formData();
    const file = form.get("file");
    if (!file || !(file instanceof File)) {
      return NextResponse.json({ error: "file 필요" }, { status: 400 });
    }

    const name = file.name || "reservation.xlsx";
    const lower = name.toLowerCase();
    if (!lower.endsWith(".xlsx") && !lower.endsWith(".xls")) {
      return NextResponse.json(
        { error: "XLSX/XLS 파일만 지원합니다." },
        { status: 400 }
      );
    }

    const buf = Buffer.from(await file.arrayBuffer());
    if (buf.length === 0) {
      return NextResponse.json({ error: "빈 파일입니다." }, { status: 400 });
    }

    const defaultDateRaw = form.get("defaultDate");
    const defaultDate =
      typeof defaultDateRaw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(defaultDateRaw)
        ? defaultDateRaw
        : null;

    const result = parseReservationWorkbook(buf, {
      filename: name,
      defaultDate,
    });

    return NextResponse.json({
      filename: name,
      ...result,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "preview 실패";
    console.error("[POST /api/reservations/preview]", e);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
