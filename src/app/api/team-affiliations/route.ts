import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, resolveAuthUser } from "@/lib/auth";
import { todayYmd } from "@/lib/dailyBoardPublished";
import {
  TeamAffiliationError,
} from "@/lib/teamAffiliation";
import {
  listTeamAffiliationVersions,
  loadTeamAffiliationSnapshot,
  saveTeamAffiliationVersion,
} from "@/lib/teamAffiliationService";

export const dynamic = "force-dynamic";

function errorResponse(e: unknown) {
  if (e instanceof TeamAffiliationError) {
    return NextResponse.json(
      { error: e.message, code: e.code },
      { status: e.status }
    );
  }
  console.error("team-affiliations", e);
  return NextResponse.json(
    { error: e instanceof Error ? e.message : "조 설정 처리 실패" },
    { status: 500 }
  );
}

/** GET: 날짜 기준 조 소속 스냅샷. 운영 명단은 변경하지 않음. */
export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard) return guard;
  try {
    const date =
      req.nextUrl.searchParams.get("date")?.trim() || todayYmd();
    const [snapshot, versions] = await Promise.all([
      loadTeamAffiliationSnapshot(date),
      listTeamAffiliationVersions(),
    ]);
    return NextResponse.json({
      snapshot,
      versions,
      defaults: {
        note: "설정이 없으면 1~8조 HOUSE, 9~12조 THIRD, 전원 운영",
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}

/**
 * PUT: 적용일 버전 저장.
 * Caddy.caddyType / team / 재직상태 / 확정 배치표는 수정하지 않는다.
 */
export async function PUT(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard) return guard;
  try {
    const auth = await resolveAuthUser(req);
    const body = await req.json();
    const saved = await saveTeamAffiliationVersion({
      body,
      userId: auth?.userId ?? null,
    });
    const versions = await listTeamAffiliationVersions();
    return NextResponse.json({
      ok: true,
      snapshot: saved.snapshot,
      versionId: saved.versionId,
      versions,
      caddyRowsUnchanged: true,
      publishedBoardsUnchanged: true,
    });
  } catch (e) {
    return errorResponse(e);
  }
}
