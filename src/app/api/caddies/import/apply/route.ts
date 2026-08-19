import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  applyRosterImportPayloadV2,
  RosterImportApplyError,
  type RosterApplyPayload,
} from "@/lib/caddyRosterImportV2";
import { isNeedsReviewName } from "@/lib/caddyImportRules";
import { maskKrMobile } from "@/lib/caddyPhone";
import { logAudit } from "@/lib/audit";
import { requireAdmin } from "@/lib/auth";
import { ROSTER_IMPORT_APPLY_FAILED_USER_MESSAGE } from "@/lib/caddyRosterImportApplyConfig";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
/**
 * Vercel Fluid 기본/Hobby 상한 300s 이내.
 * transaction timeout 60s + maxWait 10s + findMany/audit headroom < 90s.
 * Next.js 15는 숫자 리터럴만 정적 추출한다.
 */
export const maxDuration = 90;

/**
 * POST { applyPayload: { updates, creates } } — Import v2
 * - 기존 id update (team / teamOrder / employmentStatus / phone / thirdBandSubgroup)
 * - 신규 create (name+team 필수)
 * - extraFlags / missingFromImport / 삭제 / ID 재부여 금지
 * - Assignment/Schedule/ShiftDuty/OffRequest/User 연관 수정 없음
 */
export async function POST(req: NextRequest) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  try {
    const body = await req.json().catch(() => ({}));
    const payload = body?.applyPayload as RosterApplyPayload | undefined;

    if (
      !payload ||
      !Array.isArray(payload.updates) ||
      !Array.isArray(payload.creates)
    ) {
      return NextResponse.json(
        { error: "applyPayload.updates / applyPayload.creates 필요" },
        { status: 400 }
      );
    }

    for (const c of payload.creates) {
      if (!c?.name || !c?.team) {
        return NextResponse.json(
          { error: "create 항목에 name, team 필요" },
          { status: 400 }
        );
      }
      if (isNeedsReviewName(c.name)) {
        return NextResponse.json(
          {
            error: `확인 필요 대상은 신규 생성할 수 없습니다: ${c.name}`,
          },
          { status: 400 }
        );
      }
    }

    for (const u of payload.updates) {
      if (!u?.id) {
        return NextResponse.json(
          { error: "update 항목에 id 필요" },
          { status: 400 }
        );
      }
    }

    const forbiddenKeys = [
      "caddyType",
      "missingFromImport",
      "status",
      "phoneNormalized",
      "extraFlags",
      "extras",
    ];
    const leaked = JSON.stringify(payload);
    for (const key of forbiddenKeys) {
      if (leaked.includes(`"${key}"`)) {
        return NextResponse.json(
          {
            error: `applyPayload에 금지 필드가 포함되어 있습니다: ${key}`,
          },
          { status: 400 }
        );
      }
    }

    const existing = await prisma.caddy.findMany({
      select: {
        id: true,
        name: true,
        team: true,
        teamOrder: true,
        employmentStatus: true,
        phoneNormalized: true,
        thirdBandSubgroup: true,
        caddyType: true,
      },
    });

    const result = await applyRosterImportPayloadV2(
      {
        updates: payload.updates.map((u) => ({
          id: Number(u.id),
          ...(u.team !== undefined ? { team: String(u.team) } : {}),
          ...(u.teamOrder !== undefined
            ? { teamOrder: Number(u.teamOrder) }
            : {}),
          ...(u.employmentStatus !== undefined
            ? {
                employmentStatus: u.employmentStatus as
                  | "ACTIVE"
                  | "LEAVE"
                  | "RETIRED",
              }
            : {}),
          ...(u.phone !== undefined ? { phone: String(u.phone) } : {}),
          ...(Object.prototype.hasOwnProperty.call(u, "thirdBandSubgroup")
            ? { thirdBandSubgroup: u.thirdBandSubgroup ?? null }
            : {}),
        })),
        creates: payload.creates.map((c) => ({
          name: String(c.name),
          team: String(c.team),
          ...(c.teamOrder !== undefined
            ? { teamOrder: Number(c.teamOrder) }
            : {}),
          ...(c.employmentStatus !== undefined
            ? {
                employmentStatus: c.employmentStatus as
                  | "ACTIVE"
                  | "LEAVE"
                  | "RETIRED",
              }
            : {}),
          ...(c.phone !== undefined ? { phone: String(c.phone) } : {}),
          ...(Object.prototype.hasOwnProperty.call(c, "thirdBandSubgroup")
            ? { thirdBandSubgroup: c.thirdBandSubgroup ?? null }
            : {}),
        })),
      },
      prisma,
      {
        existingForGuard: existing.map((e) => ({
          id: e.id,
          name: e.name,
          team: e.team,
          teamOrder: e.teamOrder,
          employmentStatus: String(e.employmentStatus),
          phoneNormalized: e.phoneNormalized,
          thirdBandSubgroup: e.thirdBandSubgroup ?? null,
          caddyType: e.caddyType,
        })),
      }
    );

    const maskedUpdates = payload.updates.map((u) => ({
      id: Number(u.id),
      ...(u.team !== undefined ? { team: String(u.team) } : {}),
      ...(u.teamOrder !== undefined ? { teamOrder: Number(u.teamOrder) } : {}),
      ...(u.employmentStatus !== undefined
        ? { employmentStatus: u.employmentStatus }
        : {}),
      ...(u.phone !== undefined
        ? { phone: maskKrMobile(String(u.phone)) }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(u, "thirdBandSubgroup")
        ? { thirdBandSubgroup: u.thirdBandSubgroup ?? null }
        : {}),
    }));
    const maskedCreates = payload.creates.map((c) => ({
      name: String(c.name),
      team: String(c.team),
      ...(c.teamOrder !== undefined ? { teamOrder: Number(c.teamOrder) } : {}),
      ...(c.employmentStatus !== undefined
        ? { employmentStatus: c.employmentStatus }
        : {}),
      ...(c.phone !== undefined
        ? { phone: maskKrMobile(String(c.phone)) }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(c, "thirdBandSubgroup")
        ? { thirdBandSubgroup: c.thirdBandSubgroup ?? null }
        : {}),
    }));

    await logAudit({
      action: "IMPORT_CADDIES_V2",
      meta: {
        entity: "Caddy",
        updated: result.updated,
        created: result.created,
        phoneUpdated: result.phoneUpdated,
        updates: maskedUpdates,
        creates: maskedCreates,
      },
    });

    return NextResponse.json({
      ok: true,
      ...result,
    });
  } catch (e: any) {
    if (e instanceof RosterImportApplyError) {
      return NextResponse.json(
        { error: e.message, code: e.code },
        { status: e.status }
      );
    }
    console.error("[POST /api/caddies/import/apply]", e?.message || e);
    return NextResponse.json(
      { error: ROSTER_IMPORT_APPLY_FAILED_USER_MESSAGE, code: "apply_failed" },
      { status: 500 }
    );
  }
}
