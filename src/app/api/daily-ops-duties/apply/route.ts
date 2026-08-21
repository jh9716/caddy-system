import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { DutyExcelError, parseDutyMarshalLeaderWorkbook } from "@/lib/dutyMarshalLeaderParser";
import {
  DailyOpsDutyError,
  previewDailyOpsDutyReplace,
  replaceDailyOpsDuties,
} from "@/lib/dailyOpsDutyService";
import {
  countByOpsRole,
  parseMatchedOpsDutyRows,
  type MatchedOpsDutyRow,
} from "@/lib/dailyOpsDuty";

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
    const contentType = req.headers.get("content-type") || "";
    let date = "";
    let confirmReplace = false;
    let matched: MatchedOpsDutyRow[] | null = null;
    let reviews: Awaited<ReturnType<typeof previewDailyOpsDutyReplace>>["reviews"] =
      [];

    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      date = String(form.get("date") || "").trim();
      confirmReplace = String(form.get("confirmReplace") || "") === "1";
      const file = form.get("file") || form.get("dutyFile");
      if (!file || !(file instanceof File)) {
        return NextResponse.json(
          { error: "당번·마샬·조장 파일 필요" },
          { status: 400 }
        );
      }
      const name = file.name || "";
      if (name && !/\.(xlsx|xlsm)$/i.test(name)) {
        throw new DutyExcelError(
          "당번·마샬·조장 파일은 xlsx 또는 xlsm 이어야 합니다."
        );
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return NextResponse.json({ error: "date=YYYY-MM-DD 필요" }, { status: 400 });
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
      matched = preview.matched;
      reviews = preview.reviews;
    } else {
      const body = await req.json().catch(() => null);
      if (!body || typeof body !== "object") {
        return NextResponse.json({ error: "JSON 또는 multipart 필요" }, { status: 400 });
      }
      date = String(body.date || "").trim();
      confirmReplace = body.confirmReplace === true || body.confirmReplace === "1";
      try {
        matched = parseMatchedOpsDutyRows(body.matched);
      } catch (e: unknown) {
        return NextResponse.json(
          {
            error: e instanceof Error ? e.message : "matched[] 필요",
            code: "matched_invalid",
          },
          { status: 400 }
        );
      }
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ error: "date=YYYY-MM-DD 필요" }, { status: 400 });
    }
    if (!matched) {
      return NextResponse.json({ error: "저장할 일정이 없습니다." }, { status: 400 });
    }

    const result = await replaceDailyOpsDuties({
      date,
      matched,
      confirmReplace,
      ip: ipOf(req),
    });
    return NextResponse.json({
      persisted: true,
      date: result.date,
      replaced: result.replaced,
      previousCount: result.previousCount,
      savedCount: result.saved.length,
      byRole: countByOpsRole(result.saved),
      saved: result.saved,
      reviews,
    });
  } catch (e: unknown) {
    if (e instanceof DutyExcelError || e instanceof DailyOpsDutyError) {
      return NextResponse.json(
        { error: e.message, code: e.code },
        { status: e.status }
      );
    }
    const message = e instanceof Error ? e.message : "당번 일정 저장 실패";
    console.error("[POST /api/daily-ops-duties/apply]", e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
