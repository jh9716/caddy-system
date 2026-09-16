import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import { isYmd } from "@/lib/dailyBoardDraft";
import { getDailyBoardDraftVersion } from "@/lib/dailyBoardDraftService";
import { getDailyBoardPublished } from "@/lib/dailyBoardPublishedService";
import { resolvePublishedFreshness } from "@/lib/alimtalkPublishedFreshness";
import {
  buildAlimtalkWorkNoticePreview,
  emptyAlimtalkWorkNoticePreview,
} from "@/lib/alimtalkWorkNoticePreview";

export const dynamic = "force-dynamic";

/**
 * GET /api/notifications/alimtalk/preview?date=YYYY-MM-DD
 * 관리자 전용 READ-ONLY. Published만. 실제 발송/provider/POST 없음.
 * freshness 는 서버에서 매번 재계산. 향후 send 도 같은 helper 를 호출해야 한다.
 */
export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard) return guard;

  const date = String(req.nextUrl.searchParams.get("date") ?? "").trim();
  if (!isYmd(date)) {
    return NextResponse.json({ error: "date=YYYY-MM-DD 필요" }, { status: 400 });
  }

  try {
    const [published, currentDraftVersion] = await Promise.all([
      getDailyBoardPublished(date),
      getDailyBoardDraftVersion(date),
    ]);
    const freshness = resolvePublishedFreshness({
      hasPublished: Boolean(published),
      publishedSourceDraftVersion: published?.sourceDraftVersion ?? null,
      currentDraftVersion,
    });

    if (!published) {
      return NextResponse.json(emptyAlimtalkWorkNoticePreview(date, freshness));
    }

    const ids = [
      ...new Set(
        published.payload.placements
          .map((row) => row.caddyId)
          .filter((id): id is number => Number.isInteger(id) && Number(id) > 0)
      ),
    ];
    const caddies =
      ids.length === 0
        ? []
        : await prisma.caddy.findMany({
            where: { id: { in: ids } },
            select: {
              id: true,
              name: true,
              team: true,
              caddyType: true,
              phoneNormalized: true,
            },
          });

    return NextResponse.json(
      buildAlimtalkWorkNoticePreview({
        payload: published.payload,
        caddies,
        sourceDraftVersion: published.sourceDraftVersion,
        currentDraftVersion,
        freshness,
      })
    );
  } catch (e: unknown) {
    console.error("GET /api/notifications/alimtalk/preview error");
    const message = e instanceof Error ? e.message : "미리보기 실패";
    return NextResponse.json({ error: message || "미리보기 실패" }, { status: 500 });
  }
}
