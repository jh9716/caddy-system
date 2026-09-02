import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { DailyOpsDutyError, previewDailyOpsDutyReplace } from "@/lib/dailyOpsDutyService";
import { countByOpsRole } from "@/lib/dailyOpsDuty";
import {
  fetchPublishedOpsDutySheets,
  OpsDutySheetError,
} from "@/lib/opsDutySheetFetch";
import {
  buildOpsDutySheetSlots,
  opsDutySheetApplyBlockReason,
  parseOpsDutySheetsForDate,
} from "@/lib/opsDutySheetParser";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard) return guard;
  try {
    const date = String(req.nextUrl.searchParams.get("date") || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ error: "date=YYYY-MM-DD 필요" }, { status: 400 });
    }
    const sheets = await fetchPublishedOpsDutySheets({ timeoutMs: 15_000 });
    const parsed = parseOpsDutySheetsForDate(sheets, date);
    const caddies = await prisma.caddy.findMany({
      select: { id: true, name: true, employmentStatus: true },
    });
    const preview = await previewDailyOpsDutyReplace({
      date,
      entries: parsed.entries,
      caddies,
    });
    const slots = buildOpsDutySheetSlots({
      entries: parsed.entries,
      matched: preview.matched,
      reviews: preview.reviews,
    });
    const applyBlockReason = opsDutySheetApplyBlockReason({
      matched: preview.matched,
      reviews: preview.reviews,
    });
    return NextResponse.json({
      persisted: false,
      source: "spreadsheet",
      date,
      sheetName: parsed.sheetName,
      dateColumn: parsed.dateColumn,
      dateRow: parsed.dateRow,
      parsedCount: parsed.entries.length,
      matchedCount: preview.matched.length,
      reviewCount: preview.reviews.length,
      existingCount: preview.existingCount,
      replaceRequired: preview.existingCount > 0,
      canApply: !applyBlockReason,
      applyBlockReason,
      byRole: countByOpsRole(preview.matched),
      matched: preview.matched,
      reviews: preview.reviews,
      existing: preview.existing,
      entries: parsed.entries,
      slots,
    });
  } catch (e: unknown) {
    if (e instanceof OpsDutySheetError || e instanceof DailyOpsDutyError) {
      return NextResponse.json(
        { error: e.message, code: e.code, source: "spreadsheet", canApply: false },
        { status: e.status }
      );
    }
    const message = e instanceof Error ? e.message : "운영배치 Spreadsheet 미리보기 실패";
    console.error("[GET /api/daily-ops-duties/sheet-preview]", e);
    return NextResponse.json({ error: message, canApply: false }, { status: 400 });
  }
}
