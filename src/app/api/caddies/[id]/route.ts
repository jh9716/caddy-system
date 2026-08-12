import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { caddyUpdateSchema } from "@/lib/caddySchema";
import {
  normalizeEmploymentStatus,
  normalizeExtraFlags,
  normalizeTeamOrder,
} from "@/lib/caddyManage";
import {
  CaddyPhoneError,
  isPhoneUniqueViolation,
  maskKrMobile,
  parseOptionalPhoneInput,
} from "@/lib/caddyPhone";
import { requireAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";

function assertAdmin(req: NextRequest) {
  return requireAdmin(req) ?? null;
}

/** PATCH: 이름/조/조내순번/재직상태/extraFlags/phone 수정 — ID 불변 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> | { id: string } }
) {
  const denied = assertAdmin(req);
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
      updateData.extraFlags = normalizeExtraFlags(data.extraFlags);
    }
    if (data.status !== undefined) updateData.status = data.status;
    if (data.memo !== undefined) updateData.memo = data.memo;
    // phone: only when key present — omit keeps existing value
    if (Object.prototype.hasOwnProperty.call(body, "phone")) {
      updateData.phoneNormalized = parseOptionalPhoneInput(data.phone);
    }
    // Only touch Production-critical fields when explicitly sent
    if (data.employeeCode !== undefined) {
      updateData.employeeCode = data.employeeCode;
    }
    if (data.caddyType !== undefined) updateData.caddyType = data.caddyType;
    if (data.missingFromImport !== undefined) {
      updateData.missingFromImport = data.missingFromImport;
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

    await logAudit({
      action: "UPDATE_CADDY",
      meta: { entity: "Caddy", entityId: id, payload: auditPayload },
    });

    return NextResponse.json(updated);
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
  const denied = assertAdmin(req);
  if (denied) return denied;

  try {
    const resolved = await Promise.resolve(params);
    const id = Number(resolved.id);
    if (!id) {
      return NextResponse.json({ error: "id 필요" }, { status: 400 });
    }

    // soft-retire only — never prisma.caddy.delete / deleteMany
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
