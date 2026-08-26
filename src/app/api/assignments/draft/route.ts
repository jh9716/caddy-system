import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, resolveAuthUser } from "@/lib/auth";
import { resolveDraftRequestDate } from "@/lib/dailyBoardDraft";
import {
  DailyBoardDraftConflictError,
  DailyBoardDraftPayloadError,
  DRAFT_VERSION_CONFLICT,
  DRAFT_VERSION_CONFLICT_MESSAGE,
  getDailyBoardDraft,
  resetDailyBoardDraft,
  saveDailyBoardDraft,
} from "@/lib/dailyBoardDraftService";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function dateFromRequest(req: NextRequest, bodyDate?: unknown): string | null {
  return resolveDraftRequestDate(req.nextUrl.searchParams.get("date"), bodyDate);
}

function conflictResponse(err: DailyBoardDraftConflictError) {
  return NextResponse.json(
    {
      error: DRAFT_VERSION_CONFLICT,
      code: DRAFT_VERSION_CONFLICT,
      message: DRAFT_VERSION_CONFLICT_MESSAGE,
      draft: err.current,
    },
    { status: 409 }
  );
}

/** GET /api/assignments/draft?date=YYYY-MM-DD — 경기과 admin 전용 */
export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard) return guard;
  const date = dateFromRequest(req);
  if (!date) {
    return NextResponse.json({ error: "date=YYYY-MM-DD 필요" }, { status: 400 });
  }
  try {
    const draft = await getDailyBoardDraft(date);
    return NextResponse.json({ ok: true, date, draft });
  } catch (e: unknown) {
    if (e instanceof DailyBoardDraftPayloadError) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: 400 });
    }
    console.error("[GET /api/assignments/draft]", e);
    return NextResponse.json({ error: "작업본 조회 실패" }, { status: 500 });
  }
}

/** PUT /api/assignments/draft — upsert. expectedVersion=0 은 신규 생성 */
export async function PUT(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard) return guard;
  const auth = await resolveAuthUser(req);
  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "JSON body 필요" }, { status: 400 });
    }
    const date = dateFromRequest(req, (body as { date?: unknown }).date);
    if (!date) {
      return NextResponse.json(
        { error: "date=YYYY-MM-DD 필요 (URL과 body 날짜가 같아야 합니다)" },
        { status: 400 }
      );
    }
    const saved = await saveDailyBoardDraft({
      date,
      expectedVersion: Number((body as { version?: unknown }).version),
      payload: (body as { payload?: unknown }).payload,
      updatedByUserId: auth?.userId ?? null,
    });
    return NextResponse.json({ ok: true, draft: saved });
  } catch (e: unknown) {
    if (e instanceof DailyBoardDraftConflictError) {
      return conflictResponse(e);
    }
    if (e instanceof DailyBoardDraftPayloadError) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: 400 });
    }
    console.error("[PUT /api/assignments/draft]", e);
    return NextResponse.json({ error: "작업본 저장 실패" }, { status: 500 });
  }
}

/** DELETE /api/assignments/draft?date=YYYY-MM-DD — Draft만 삭제 */
export async function DELETE(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard) return guard;
  const date = dateFromRequest(req);
  if (!date) {
    return NextResponse.json({ error: "date=YYYY-MM-DD 필요" }, { status: 400 });
  }
  try {
    const result = await resetDailyBoardDraft(date);
    return NextResponse.json({ ok: true, date, ...result });
  } catch (e: unknown) {
    console.error("[DELETE /api/assignments/draft]", e);
    return NextResponse.json({ error: "작업본 초기화 실패" }, { status: 500 });
  }
}
