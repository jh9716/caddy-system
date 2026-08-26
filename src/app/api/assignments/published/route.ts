import { NextRequest, NextResponse } from "next/server";
import {
  requireAdmin,
  requirePublishedReader,
  resolveAuthUser,
} from "@/lib/auth";
import { isYmd, resolveDraftRequestDate } from "@/lib/dailyBoardDraft";
import {
  DailyBoardPublishedPayloadError,
  PUBLISH_NO_DRAFT,
  PUBLISH_STALE_DRAFT,
} from "@/lib/dailyBoardPublished";
import {
  DailyBoardPublishNoDraftError,
  DailyBoardPublishStaleError,
  getDailyBoardPublished,
  publishDailyBoard,
} from "@/lib/dailyBoardPublishedService";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function dateFromRequest(req: NextRequest, bodyDate?: unknown): string | null {
  return resolveDraftRequestDate(req.nextUrl.searchParams.get("date"), bodyDate);
}

/**
 * GET /api/assignments/published?date=YYYY-MM-DD
 * 경기과/캐디/조장 읽기 전용. Draft 존재 여부는 응답하지 않는다.
 */
export async function GET(req: NextRequest) {
  const guard = await requirePublishedReader(req);
  if (guard) return guard;
  const date = dateFromRequest(req);
  if (!date || !isYmd(date)) {
    return NextResponse.json({ error: "date=YYYY-MM-DD 필요" }, { status: 400 });
  }
  try {
    const published = await getDailyBoardPublished(date);
    return NextResponse.json({
      ok: true,
      date,
      published: published
        ? {
            date: published.date,
            schemaVersion: published.schemaVersion,
            sourceDraftVersion: published.sourceDraftVersion,
            payload: published.payload,
            publishedAt: published.publishedAt,
            publishedByUserId: published.publishedByUserId,
            publishedByUsername: published.payload.publisherUsername,
          }
        : null,
    });
  } catch (e: unknown) {
    if (e instanceof DailyBoardPublishedPayloadError) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: 400 });
    }
    console.error("[GET /api/assignments/published]", e);
    return NextResponse.json({ error: "배치표 조회 실패" }, { status: 500 });
  }
}

/**
 * POST /api/assignments/published
 * 경기과 admin 전용. 서버의 최신 Draft를 source of truth로 Published snapshot 생성.
 * body: { date, draftVersion } — 클라이언트 board JSON은 저장하지 않는다.
 */
export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard) return guard;
  const auth = await resolveAuthUser(req);
  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "JSON body 필요" }, { status: 400 });
    }
    const raw = body as { date?: unknown; draftVersion?: unknown; payload?: unknown };
    if ("payload" in raw || "placements" in (raw as object) || "board" in (raw as object)) {
      return NextResponse.json(
        { error: "클라이언트 배치 JSON은 저장하지 않습니다. draftVersion만 보내세요." },
        { status: 400 }
      );
    }
    const date = dateFromRequest(req, raw.date);
    if (!date) {
      return NextResponse.json(
        { error: "date=YYYY-MM-DD 필요 (URL과 body 날짜가 같아야 합니다)" },
        { status: 400 }
      );
    }
    const published = await publishDailyBoard({
      date,
      expectedDraftVersion: Number(raw.draftVersion),
      publishedByUserId: auth?.userId ?? null,
      publisherUsername: auth?.username ?? null,
    });
    return NextResponse.json({
      ok: true,
      message: "배치가 확정되었습니다.",
      published: {
        date: published.date,
        schemaVersion: published.schemaVersion,
        sourceDraftVersion: published.sourceDraftVersion,
        payload: published.payload,
        publishedAt: published.publishedAt,
        publishedByUserId: published.publishedByUserId,
        publishedByUsername: published.payload.publisherUsername,
      },
    });
  } catch (e: unknown) {
    if (e instanceof DailyBoardPublishStaleError) {
      return NextResponse.json(
        {
          error: PUBLISH_STALE_DRAFT,
          code: PUBLISH_STALE_DRAFT,
          message: e.message,
        },
        { status: 409 }
      );
    }
    if (e instanceof DailyBoardPublishNoDraftError) {
      return NextResponse.json(
        {
          error: PUBLISH_NO_DRAFT,
          code: PUBLISH_NO_DRAFT,
          message: e.message,
        },
        { status: 404 }
      );
    }
    if (e instanceof DailyBoardPublishedPayloadError) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: 400 });
    }
    console.error("[POST /api/assignments/published]", e);
    return NextResponse.json({ error: "배치 확정 실패" }, { status: 500 });
  }
}
