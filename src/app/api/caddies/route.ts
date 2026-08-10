import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { caddyCreateSchema } from "@/lib/caddySchema";
import {
  normalizeEmploymentStatus,
  normalizeExtraFlags,
  normalizeTeamOrder,
} from "@/lib/caddyManage";
import { requireAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** GET: 캐디 목록 (관리자 전용. 기본: 재직만, ?employment=all|재직|퇴사) */
export async function GET(req: NextRequest) {
  const guard = requireAdmin(req);
  if (guard) return guard;

  try {
    const employment = req.nextUrl.searchParams.get("employment") || "재직";
    const where =
      employment === "all"
        ? {}
        : { employmentStatus: employment === "퇴사" ? "퇴사" : "재직" };

    const caddies = await prisma.caddy.findMany({
      where,
      orderBy: [{ team: "asc" }, { teamOrder: "asc" }, { id: "asc" }],
    });
    return NextResponse.json(caddies);
  } catch (e: any) {
    console.error("GET /api/caddies error:", e);
    return NextResponse.json(
      { error: e?.message || "불러오기 실패" },
      { status: 500 }
    );
  }
}

/** POST: 신규 캐디 등록 (새 ID 발급, 기존 ID 변경 없음) */
export async function POST(req: NextRequest) {
  const guard = requireAdmin(req);
  if (guard) return guard;

  try {
    const body = await req.json();
    const parsed = caddyCreateSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message || "입력 오류" },
        { status: 400 }
      );
    }

    const data = parsed.data;
    const team = data.team.trim();
    const maxOrder = await prisma.caddy.aggregate({
      where: { team },
      _max: { teamOrder: true },
    });
    const teamOrder =
      data.teamOrder && data.teamOrder > 0
        ? data.teamOrder
        : (maxOrder._max.teamOrder ?? 0) + 1;

    const created = await prisma.caddy.create({
      data: {
        name: data.name.trim(),
        team,
        teamOrder: normalizeTeamOrder(teamOrder),
        employmentStatus: normalizeEmploymentStatus(data.employmentStatus),
        extraFlags: normalizeExtraFlags(data.extraFlags),
        status: data.status ?? "근무중",
        memo: data.memo ?? null,
      },
    });
    return NextResponse.json(created);
  } catch (e: any) {
    console.error("POST /api/caddies error:", e);
    return NextResponse.json(
      { error: e?.message || "추가 실패" },
      { status: 500 }
    );
  }
}

/**
 * DELETE 쿼리(?id=) — 물리 삭제 금지.
 * 하위 호환: 퇴사(soft) 처리만 수행. Assignment/Schedule 유지.
 */
export async function DELETE(req: NextRequest) {
  const guard = requireAdmin(req);
  if (guard) return guard;

  try {
    const { searchParams } = new URL(req.url);
    const id = Number(searchParams.get("id"));
    if (!id) return NextResponse.json({ error: "id 필요" }, { status: 400 });

    const updated = await prisma.caddy.update({
      where: { id },
      data: { employmentStatus: "퇴사" },
    });
    return NextResponse.json({
      ok: true,
      softDeleted: true,
      id: updated.id,
      employmentStatus: updated.employmentStatus,
    });
  } catch (e: any) {
    console.error("DELETE /api/caddies error:", e);
    return NextResponse.json(
      { error: e?.message || "퇴사 처리 실패" },
      { status: 500 }
    );
  }
}
