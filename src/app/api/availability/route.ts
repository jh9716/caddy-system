import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { loadAvailabilityForDate } from "@/lib/availabilityService";
import { OffSheetError } from "@/lib/offSheetFetch";
import { DutyExcelError } from "@/lib/dutyMarshalLeaderParser";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function errorResponse(e: unknown) {
  if (e instanceof OffSheetError || e instanceof DutyExcelError) {
    return NextResponse.json(
      { error: e.message, code: e.code },
      { status: e.status }
    );
  }
  const message = e instanceof Error ? e.message : "가용 계산 실패";
  console.error("[/api/availability]", e);
  return NextResponse.json({ error: message }, { status: 500 });
}

async function dutyBufferFromForm(
  form: FormData
): Promise<Buffer | null> {
  const file = form.get("dutyFile") || form.get("file");
  if (!file || !(file instanceof File)) return null;
  const name = file.name || "";
  if (name && !/\.(xlsx|xlsm)$/i.test(name)) {
    throw new DutyExcelError("당번·마샬·조장 파일은 xlsx 또는 xlsm 이어야 합니다.");
  }
  return Buffer.from(await file.arrayBuffer());
}

/**
 * GET /api/availability?date=YYYY-MM-DD
 * 가용 + 운영 휴무 Sheet 제외 (읽기 전용).
 */
export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard) return guard;

  try {
    const date = req.nextUrl.searchParams.get("date")?.trim() || "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json(
        { error: "date=YYYY-MM-DD 필요" },
        { status: 400 }
      );
    }
    const result = await loadAvailabilityForDate(date);
    return NextResponse.json(result);
  } catch (e: unknown) {
    return errorResponse(e);
  }
}

/**
 * POST multipart: date + optional dutyFile(xlsx/xlsm)
 */
export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard) return guard;

  try {
    const contentType = req.headers.get("content-type") || "";
    if (!contentType.includes("multipart/form-data")) {
      return NextResponse.json(
        { error: "multipart/form-data 필요 (date, dutyFile?)" },
        { status: 400 }
      );
    }
    const form = await req.formData();
    const date = String(form.get("date") || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json(
        { error: "date=YYYY-MM-DD 필요" },
        { status: 400 }
      );
    }
    const dutyWorkbook = await dutyBufferFromForm(form);
    const result = await loadAvailabilityForDate(date, {
      dutyWorkbook,
      forceOffSheet: true,
    });
    return NextResponse.json(result);
  } catch (e: unknown) {
    return errorResponse(e);
  }
}
