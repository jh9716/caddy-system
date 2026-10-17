/**
 * POST /api/caddies/reassign/apply
 * 조/순번 일괄 재배치. 단일 트랜잭션. 일부만 저장하지 않음.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin, resolveAuthUser } from "@/lib/auth";
import { CaddyReassignError } from "@/lib/caddyReassign";
import {
  applyCaddyReassign,
  parseCaddyReassignRequest,
  reassignErrorBody,
} from "@/lib/caddyReassignApply";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
/** Next.js 15는 숫자 리터럴만 정적 추출. tx 20s + maxWait 10s + headroom. */
export const maxDuration = 45;

function clientIp(req: NextRequest): string | null {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() || null;
  return req.headers.get("x-real-ip");
}

export async function POST(req: NextRequest) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  try {
    const request = parseCaddyReassignRequest(await req.json().catch(() => ({})));
    if (!request.base || request.base.length === 0) {
      throw new CaddyReassignError(
        "동시 수정 확인을 위해 Preview의 base 스냅샷이 필요합니다.",
        { status: 400, code: "stale_roster" }
      );
    }
    const auth = await resolveAuthUser(req);
    const result = await applyCaddyReassign({
      db: prisma,
      placements: request.placements,
      mode: request.mode,
      base: request.base,
      actor: {
        username: auth?.username ?? null,
        userId: auth?.userId ?? null,
        ip: clientIp(req),
      },
    });
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof CaddyReassignError) {
      return NextResponse.json(reassignErrorBody(e), { status: e.status });
    }
    console.error("[POST /api/caddies/reassign/apply]", e);
    return NextResponse.json(
      {
        error: "재배치 저장에 실패했습니다. 데이터가 반영되지 않았습니다.",
        code: "apply_failed",
      },
      { status: 500 }
    );
  }
}
