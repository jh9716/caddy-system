import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { DutyExcelError, parseDutyMarshalLeaderWorkbook } from "@/lib/dutyMarshalLeaderParser";
import { previewDailyOpsDutyReplace, DailyOpsDutyError } from "@/lib/dailyOpsDutyService";
import { countByOpsRole } from "@/lib/dailyOpsDuty";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard) return guard;
  try {
    const contentType = req.headers.get("content-type") || "";
    if (!contentType.includes("multipart/form-data")) {
      return NextResponse.json(
        { error: "multipart/form-data 필요 (date, file)" },
        { status: 400 }
      );
    }
    const form = await req.formData();
    const date = String(form.get("date") || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ error: "date=YYYY-MM-DD 필요" }, { status: 400 });
    }
    const file = form.get("file") || form.get("dutyFile");
    if (!file || !(file instanceof File)) {
      return NextResponse.json({ error: "당번·마샬·조장 파일 필요" }, { status: 400 });
    }
    const name = file.name || "";
    if (name && !/\.(xlsx|xlsm)$/i.test(name)) {
      throw new DutyExcelError("당번·마샬·조장 파일은 xlsx 또는 xlsm 이어야 합니다.");
    }
    const parsed = parseDutyMarshalLeaderWorkbook(
      Buffer.from(await file.arrayBuffer()),
      date
    );
    const caddies = await prisma.caddy.findMany({
      select: { id: true, name: true, employmentStatus: true },
    });
    const preview = await previewDailyOpsDutyReplace({
      date,
      entries: parsed.entries,
      caddies,
    });
    return NextResponse.json({
      persisted: false,
      date,
      dateColumn: parsed.dateColumn,
      filename: file.name,
      parsedCount: parsed.entries.length,
      matchedCount: preview.matched.length,
      reviewCount: preview.reviews.length,
      existingCount: preview.existingCount,
      replaceRequired: preview.existingCount > 0,
      byRole: countByOpsRole(preview.matched),
      matched: preview.matched,
      reviews: preview.reviews,
      existing: preview.existing,
      entries: parsed.entries,
    });
  } catch (e: unknown) {
    if (e instanceof DutyExcelError || e instanceof DailyOpsDutyError) {
      return NextResponse.json(
        { error: e.message, code: e.code },
        { status: e.status }
      );
    }
    const message = e instanceof Error ? e.message : "당번 일정 미리보기 실패";
    console.error("[POST /api/daily-ops-duties/preview]", e);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
