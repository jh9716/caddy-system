import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { caddyCreateSchema } from "@/lib/caddySchema";
import {
  normalizeEmploymentStatus,
  normalizeExtraFlags,
  normalizeTeamOrder,
  parseEmploymentFilter,
} from "@/lib/caddyManage";
import {
  CaddyPhoneError,
  isPhoneUniqueViolation,
  parseOptionalPhoneInput,
} from "@/lib/caddyPhone";
import { requireAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** GET: 캐디 목록 (관리자 전용. 기본: ACTIVE, ?employment=all|ACTIVE|LEAVE|RETIRED|재직|휴직|퇴사) */
export async function GET(req: NextRequest) {
  const guard = requireAdmin(req);
  if (guard) return guard;

  try {
    const employment = parseEmploymentFilter(
      req.nextUrl.searchParams.get("employment")
    );
    const where =
      employment === "all" ? {} : { employmentStatus: employment };

    const caddies = await prisma.caddy.findMany({
      where,
      orderBy: [{ team: "asc" }, { teamOrder: "asc" }, { id: "asc" }],
    });
    // admin-only route: phoneNormalized 원문 포함 가능 (UI에서 마스킹)
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
    // 미입력/빈값 → null (기존 183명은 전부 null 유지 패턴)
    const phoneNormalized =
      data.phone === undefined ? null : parseOptionalPhoneInput(data.phone);

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
        phoneNormalized,
        // Preserve Production columns: only set when explicitly provided
        ...(data.employeeCode !== undefined
          ? { employeeCode: data.employeeCode }
          : {}),
        ...(data.caddyType !== undefined ? { caddyType: data.caddyType } : {}),
        ...(data.missingFromImport !== undefined
          ? { missingFromImport: data.missingFromImport }
          : {}),
      },
    });
    return NextResponse.json(created);
  } catch (e: any) {
    if (e instanceof CaddyPhoneError) {
      return NextResponse.json(
        { error: e.message, code: e.code },
        { status: e.status }
      );
    }
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      isPhoneUniqueViolation(e)
    ) {
      return NextResponse.json(
        {
          error: "이미 등록된 휴대폰번호입니다.",
          code: "phone_duplicate",
        },
        { status: 409 }
      );
    }
    console.error("POST /api/caddies error:", e);
    return NextResponse.json(
      { error: e?.message || "추가 실패" },
      { status: 500 }
    );
  }
}

/**
 * DELETE 쿼리(?id=) — 물리 삭제 절대 금지 (prisma.caddy.delete 사용 금지).
 * 하위 호환: RETIRED(soft) 처리만 수행. Assignment/Schedule 유지.
 */
export async function DELETE(req: NextRequest) {
  const guard = requireAdmin(req);
  if (guard) return guard;

  try {
    const { searchParams } = new URL(req.url);
    const id = Number(searchParams.get("id"));
    if (!id) return NextResponse.json({ error: "id 필요" }, { status: 400 });

    // soft-retire only — never prisma.caddy.delete / deleteMany
    const updated = await prisma.caddy.update({
      where: { id },
      data: { employmentStatus: "RETIRED" },
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
