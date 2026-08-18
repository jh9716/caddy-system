import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { caddyUpdateSchema } from "@/lib/caddySchema";
import {
  ThirdBandSubgroupError,
  mergeExtraFlagsForPersist,
  normalizeEmploymentStatus,
  normalizeTeamOrder,
  resolveCaddyTypeFromTeam,
  resolveThirdBandSubgroup,
} from "@/lib/caddyManage";
import {
  CaddyPhoneError,
  isPhoneUniqueViolation,
  maskKrMobile,
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

/** PATCH: 이름/조/고정슬롯/재직상태/extraFlags/phone 수정 — ID 불변 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> | { id: string } }
) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  try {
    const resolved = await Promise.resolve(params);
    const id = Number(resolved.id);
    if (!id) {
      return NextResponse.json({ error: "id 필요" }, { status: 400 });
    }

    const body = await req.json();
    const parsed = caddyUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message || "입력 오류" },
        { status: 400 }
      );
    }

    const data = parsed.data;
    const current = await prisma.caddy.findUnique({ where: { id } });
    if (!current) {
      return NextResponse.json({ error: "캐디 없음" }, { status: 404 });
    }

    // ↑↓ 원자적 슬롯 스왑 (같은 조, ACTIVE/LEAVE 점유 교환)
    if (data.swapWithId != null) {
      const otherId = Number(data.swapWithId);
      if (!otherId || otherId === id) {
        return NextResponse.json(
          { error: "swapWithId가 올바르지 않습니다." },
          { status: 400 }
        );
      }
      const other = await prisma.caddy.findUnique({ where: { id: otherId } });
      if (!other) {
        return NextResponse.json(
          { error: "스왑 대상 캐디 없음" },
          { status: 404 }
        );
      }
      if (other.team !== current.team) {
        return NextResponse.json(
          { error: "같은 조에서만 슬롯을 교환할 수 있습니다." },
          { status: 400 }
        );
      }
      const orderA = current.teamOrder;
      const orderB = other.teamOrder;
      const [updated] = await prisma.$transaction([
        prisma.caddy.update({
          where: { id },
          data: { teamOrder: orderB },
        }),
        prisma.caddy.update({
          where: { id: otherId },
          data: { teamOrder: orderA },
        }),
      ]);
      await logAudit({
        action: "SWAP_CADDY_SLOT",
        meta: {
          entity: "Caddy",
          entityId: id,
          swapWithId: otherId,
          team: current.team,
          orders: [orderA, orderB],
        },
      });
      return NextResponse.json(updated);
    }

    const nextTeam =
      data.team !== undefined ? data.team.trim() : current.team;
    const teamChanging =
      data.team !== undefined && data.team.trim() !== current.team;

    if (teamChanging && data.teamOrder === undefined) {
      return NextResponse.json(
        {
          error:
            "조 이동 시 새 조의 빈 슬롯(teamOrder)을 함께 지정해야 합니다.",
          code: "slot_required_on_team_move",
        },
        { status: 400 }
      );
    }

    const nextOrder =
      data.teamOrder !== undefined
        ? normalizeTeamOrder(data.teamOrder)
        : current.teamOrder;

    const slotChanging =
      nextTeam !== current.team || nextOrder !== current.teamOrder;

    if (slotChanging) {
      if (!Number.isInteger(nextOrder) || nextOrder < 1) {
        return NextResponse.json(
          { error: "슬롯(teamOrder)은 1 이상이어야 합니다.", code: "slot_required" },
          { status: 400 }
        );
      }
      // 신규 선택 슬롯은 capacity 이내. 기존 capacity 초과 슬롯을 그대로 유지하는 경우만 예외.
      assertSlotWithinConfiguredCapacity(nextTeam, nextOrder, {
        allowCurrentOverCapacity:
          nextTeam === current.team ? current.teamOrder : null,
      });
      const peers = await prisma.caddy.findMany({
        where: { team: nextTeam },
        select: {
          id: true,
          name: true,
          team: true,
          teamOrder: true,
          employmentStatus: true,
        },
      });
      assertSlotAvailable(
        peers.map((p) => ({
          ...p,
          employmentStatus: String(p.employmentStatus),
        })),
        nextTeam,
        nextOrder,
        id
      );
    }

    const updateData: Record<string, unknown> = {};
    if (data.name !== undefined) updateData.name = data.name.trim();
    if (data.team !== undefined) updateData.team = data.team.trim();
    if (data.teamOrder !== undefined) {
      updateData.teamOrder = normalizeTeamOrder(data.teamOrder);
    }
    if (data.employmentStatus !== undefined) {
      updateData.employmentStatus = normalizeEmploymentStatus(
        data.employmentStatus
      );
    }
    if (data.extraFlags !== undefined) {
      updateData.extraFlags = mergeExtraFlagsForPersist({
        incoming: data.extraFlags,
        current: current.extraFlags,
        mode: "update",
      });
    }
    if (data.status !== undefined) updateData.status = data.status;
    if (data.memo !== undefined) updateData.memo = data.memo;
    if (Object.prototype.hasOwnProperty.call(body, "phone")) {
      updateData.phoneNormalized = parseOptionalPhoneInput(data.phone);
    }
    if (data.employeeCode !== undefined) {
      updateData.employeeCode = data.employeeCode;
    }
    if (data.missingFromImport !== undefined) {
      updateData.missingFromImport = data.missingFromImport;
    }
    // 조 기준 canonical invariant: 1~8 HOUSE, 9~12 THIRD (클라이언트 caddyType 무시)
    updateData.caddyType = resolveCaddyTypeFromTeam(nextTeam);

    // 3부반 세부구분 invariant: 1~8조 → 항상 null, 9~12→1~8 이동 시 정리
    const subgroupRequested = Object.prototype.hasOwnProperty.call(
      body,
      "thirdBandSubgroup"
    )
      ? data.thirdBandSubgroup
      : undefined;
    updateData.thirdBandSubgroup = resolveThirdBandSubgroup({
      team: nextTeam,
      requested: subgroupRequested,
      current:
        (current as { thirdBandSubgroup?: "WEEKDAY" | "WEEKEND" | null })
          .thirdBandSubgroup ?? null,
    });

    // LEAVE/ACTIVE로 복귀·변경 시에도 최종 슬롯 점유 재확인
    if (data.employmentStatus !== undefined) {
      const emp = normalizeEmploymentStatus(data.employmentStatus);
      if (emp === "ACTIVE" || emp === "LEAVE") {
        const finalTeam = (updateData.team as string) ?? current.team;
        const finalOrder =
          (updateData.teamOrder as number | undefined) ?? current.teamOrder;
        const peers = await prisma.caddy.findMany({
          where: { team: finalTeam },
          select: {
            id: true,
            name: true,
            team: true,
            teamOrder: true,
            employmentStatus: true,
          },
        });
        assertSlotAvailable(
          peers.map((p) => ({
            ...p,
            employmentStatus: String(p.employmentStatus),
          })),
          finalTeam,
          finalOrder,
          id
        );
      }
    }

    const updated = await prisma.caddy.update({
      where: { id },
      data: updateData,
    });

    const auditPayload = { ...data } as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(auditPayload, "phone")) {
      auditPayload.phone = maskKrMobile(
        typeof updateData.phoneNormalized === "string"
          ? updateData.phoneNormalized
          : null
      );
    }
    delete auditPayload.swapWithId;

    await logAudit({
      action: "UPDATE_CADDY",
      meta: { entity: "Caddy", entityId: id, payload: auditPayload },
    });

    return NextResponse.json(updated);
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
    console.error("[PATCH /api/caddies/[id]]", e);
    const status = e?.status ?? 400;
    return NextResponse.json(
      { error: e?.message ?? "PATCH failed" },
      { status }
    );
  }
}

/**
 * DELETE /api/caddies/[id] — 물리 삭제 절대 금지 (prisma.caddy.delete 사용 금지).
 * Assignment/Schedule 관계 보존을 위해 employmentStatus=RETIRED 만 수행.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> | { id: string } }
) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  try {
    const resolved = await Promise.resolve(params);
    const id = Number(resolved.id);
    if (!id) {
      return NextResponse.json({ error: "id 필요" }, { status: 400 });
    }

    const updated = await prisma.caddy.update({
      where: { id },
      data: { employmentStatus: "RETIRED" },
    });

    await logAudit({
      action: "SOFT_DELETE_CADDY",
      meta: {
        entity: "Caddy",
        entityId: id,
        employmentStatus: "RETIRED",
      },
    });

    return NextResponse.json({
      ok: true,
      softDeleted: true,
      id: updated.id,
      employmentStatus: updated.employmentStatus,
    });
  } catch (e: any) {
    console.error("[DELETE /api/caddies/[id]]", e);
    const status = e?.status ?? 400;
    return NextResponse.json(
      { error: e?.message ?? "퇴사 처리 실패" },
      { status }
    );
  }
}
