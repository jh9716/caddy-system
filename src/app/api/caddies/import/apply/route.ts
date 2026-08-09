import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  applyImportPayload,
  type ApplyPayload,
} from "@/lib/caddyImport";
import { isNeedsReviewName } from "@/lib/caddyImportRules";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function assertAdmin(req: NextRequest) {
  const role = req.cookies.get("role")?.value;
  if (role !== "admin") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

/**
 * POST { applyPayload: { updates, creates } }
 * - 기존 id update(team만) + 신규 create만
 * - needsReview 이름 create 거부
 * - employmentStatus 변경 없음
 * - 삭제/ID 재부여 없음
 *
 * 주의: 이 엔드포인트는 호출 시에만 DB를 변경합니다.
 * 자동 배포/마이그레이션/시드에서는 호출하지 않습니다.
 */
export async function POST(req: NextRequest) {
  const denied = assertAdmin(req);
  if (denied) return denied;

  try {
    const body = await req.json().catch(() => ({}));
    const payload = body?.applyPayload as ApplyPayload | undefined;

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
      if (!u?.id || typeof u.team !== "string") {
        return NextResponse.json(
          { error: "update 항목에 id, team 필요" },
          { status: 400 }
        );
      }
    }

    // employmentStatus 등 금지 필드가 실수로 들어오면 거부
    const forbiddenKeys = [
      "employmentStatus",
      "caddyType",
      "missingFromImport",
      "status",
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
      select: { id: true, name: true, team: true },
    });

    const result = await applyImportPayload(
      {
        updates: payload.updates.map((u) => ({
          id: Number(u.id),
          team: String(u.team),
        })),
        creates: payload.creates.map((c) => ({
          name: String(c.name),
          team: String(c.team),
        })),
      },
      prisma,
      { existingForGuard: existing, rejectNeedsReviewNames: true }
    );

    return NextResponse.json({
      ok: true,
      ...result,
      touchesEmploymentStatus: false,
    });
  } catch (e: any) {
    console.error("[POST /api/caddies/import/apply]", e);
    return NextResponse.json(
      { error: e?.message || "apply 실패" },
      { status: 400 }
    );
  }
}
