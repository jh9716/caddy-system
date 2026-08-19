import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { caddyCreateSchema } from "@/lib/caddySchema";
import {
  ThirdBandSubgroupError,
  drivingPersistFields,
  isDrivingCaddyType,
  mergeExtraFlagsForPersist,
  normalizeEmploymentStatus,
  normalizeTeamOrder,
  parseEmploymentFilter,
  resolveCaddyTypeFromTeam,
  resolveThirdBandSubgroup,
} from "@/lib/caddyManage";
import {
  CaddyPhoneError,
  isPhoneUniqueViolation,
  parseOptionalPhoneInput,
} from "@/lib/caddyPhone";
import {
  SlotOccupiedError,
  SlotOutOfRangeError,
  assertSlotAvailable,
  assertSlotWithinConfiguredCapacity,
} from "@/lib/caddySlot";
import { requireAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** GET: 캐디 목록 (관리자 전용. 기본: ACTIVE, ?employment=all|ACTIVE|LEAVE|RETIRED|재직|휴직|퇴사) */
export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req);
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
    return NextResponse.json(caddies);
  } catch (e: any) {
    console.error("GET /api/caddies error:", e);
    return NextResponse.json(
      { error: e?.message || "불러오기 실패" },
      { status: 500 }
    );
  }
}

/** POST: 신규 캐디 등록 — 빈 슬롯(teamOrder) 명시 필수. max+1 자동부여 없음. */
export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req);
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
    const phoneNormalized =
      data.phone === undefined ? null : parseOptionalPhoneInput(data.phone);

    if (isDrivingCaddyType(data.caddyType)) {
      const driving = drivingPersistFields();
      const created = await prisma.caddy.create({
        data: {
          name: data.name.trim(),
          team: driving.team,
          teamOrder: driving.teamOrder,
          employmentStatus: normalizeEmploymentStatus(data.employmentStatus),
          extraFlags: mergeExtraFlagsForPersist({
            incoming: data.extraFlags,
            mode: "create",
          }),
          status: data.status ?? "근무중",
          memo: data.memo ?? null,
          phoneNormalized,
          thirdBandSubgroup: driving.thirdBandSubgroup,
          caddyType: driving.caddyType,
          ...(data.employeeCode !== undefined
            ? { employeeCode: data.employeeCode }
            : {}),
          ...(data.missingFromImport !== undefined
            ? { missingFromImport: data.missingFromImport }
            : {}),
        },
      });
      return NextResponse.json(created);
    }

    const team = String(data.team ?? "").trim();
    const teamOrder = normalizeTeamOrder(data.teamOrder);
    if (teamOrder < 1) {
      return NextResponse.json(
        { error: "빈 슬롯(teamOrder)을 선택해주세요.", code: "slot_required" },
        { status: 400 }
      );
    }
    assertSlotWithinConfiguredCapacity(team, teamOrder);

    const peers = await prisma.caddy.findMany({
      where: { team },
      select: {
        id: true,
        name: true,
        team: true,
        teamOrder: true,
        employmentStatus: true,
        caddyType: true,
      },
    });
    assertSlotAvailable(
      peers.map((p) => ({
        ...p,
        employmentStatus: String(p.employmentStatus),
      })),
      team,
      teamOrder
    );

    const thirdBandSubgroup = resolveThirdBandSubgroup({
      team,
      requested: Object.prototype.hasOwnProperty.call(body, "thirdBandSubgroup")
        ? data.thirdBandSubgroup
        : undefined,
      current: null,
    });

    const created = await prisma.caddy.create({
      data: {
        name: data.name.trim(),
        team,
        teamOrder,
        employmentStatus: normalizeEmploymentStatus(data.employmentStatus),
        extraFlags: mergeExtraFlagsForPersist({
          incoming: data.extraFlags,
          mode: "create",
        }),
        status: data.status ?? "근무중",
        memo: data.memo ?? null,
        phoneNormalized,
        thirdBandSubgroup,
        caddyType: resolveCaddyTypeFromTeam(team),
        ...(data.employeeCode !== undefined
          ? { employeeCode: data.employeeCode }
          : {}),
        ...(data.missingFromImport !== undefined
          ? { missingFromImport: data.missingFromImport }
          : {}),
      },
    });
    return NextResponse.json(created);
  } catch (e: any) {
    if (e instanceof ThirdBandSubgroupError) {
      return NextResponse.json(
        { error: e.message, code: e.code },
        { status: e.status }
      );
    }
    if (e instanceof SlotOccupiedError || e instanceof SlotOutOfRangeError) {
      return NextResponse.json(
        {
          error: e.message,
          code: e.code,
          ...(e instanceof SlotOccupiedError
            ? { occupant: e.occupant ?? null }
            : {}),
        },
        { status: e.status }
      );
    }
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
 * DELETE 쿼리(?id=) — 물리 삭제 절대 금지.
 * RETIRED(soft)만. Assignment/Schedule 유지.
 */
export async function DELETE(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard) return guard;

  try {
    const { searchParams } = new URL(req.url);
    const id = Number(searchParams.get("id"));
    if (!id) return NextResponse.json({ error: "id 필요" }, { status: 400 });

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
