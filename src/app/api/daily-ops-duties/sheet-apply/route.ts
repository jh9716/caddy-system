import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  DailyOpsDutyError,
  previewDailyOpsDutyReplace,
  replaceDailyOpsDuties,
} from "@/lib/dailyOpsDutyService";
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

function ipOf(req: NextRequest): string | null {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    null
  );
}

export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard) return guard;
  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "JSON 필요" }, { status: 400 });
    }
    const date = String(body.date || "").trim();
    const confirmReplace = body.confirmReplace === true || body.confirmReplace === "1";
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
    if (applyBlockReason) {
      return NextResponse.json(
        {
          error: applyBlockReason,
          code: preview.reviews.length ? "ops_duty_sheet_review_blocked" : "ops_duty_sheet_apply_blocked",
          persisted: false,
          source: "spreadsheet",
          date,
          canApply: false,
          applyBlockReason,
          matchedCount: preview.matched.length,
          reviewCount: preview.reviews.length,
          matched: preview.matched,
          reviews: preview.reviews,
          slots,
        },
        { status: 400 }
      );
    }

    const result = await replaceDailyOpsDuties({
      date,
      matched: preview.matched,
      confirmReplace,
      ip: ipOf(req),
    });
    return NextResponse.json({
      persisted: true,
      source: "spreadsheet",
      date: result.date,
      replaced: result.replaced,
      previousCount: result.previousCount,
      savedCount: result.saved.length,
      byRole: countByOpsRole(result.saved),
      saved: result.saved,
      reviews: preview.reviews,
      slots,
      sheetName: parsed.sheetName,
    });
  } catch (e: unknown) {
    if (e instanceof OpsDutySheetError || e instanceof DailyOpsDutyError) {
      return NextResponse.json(
        { error: e.message, code: e.code, source: "spreadsheet", canApply: false },
        { status: e.status }
      );
    }
    const message = e instanceof Error ? e.message : "운영배치 Spreadsheet 저장 실패";
    console.error("[POST /api/daily-ops-duties/sheet-apply]", e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
