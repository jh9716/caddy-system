/**
 * POST /api/caddies/reassign/preview
 * 조/순번 일괄 재배치 Preview. DB 쓰기 없음.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import { CaddyReassignError } from "@/lib/caddyReassign";
import {
  parseCaddyReassignRequest,
  previewCaddyReassign,
  reassignErrorBody,
} from "@/lib/caddyReassignApply";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  try {
    const request = parseCaddyReassignRequest(await req.json().catch(() => ({})));
    const rows = await prisma.caddy.findMany({
      select: {
        id: true,
        name: true,
        team: true,
        teamOrder: true,
        employmentStatus: true,
        caddyType: true,
        thirdBandSubgroup: true,
        updatedAt: true,
      },
    });
    const plan = previewCaddyReassign(rows, request);
    return NextResponse.json({
      ok: plan.ok,
      mode: plan.mode,
      requestedIds: plan.requestedIds,
      affectedIds: plan.affectedIds,
      affectedTeams: plan.affectedTeams,
      changes: plan.changes,
      issues: plan.issues,
      existingAnomalies: plan.existingAnomalies,
      base: plan.base,
    });
  } catch (e) {
    if (e instanceof CaddyReassignError) {
      return NextResponse.json(reassignErrorBody(e), { status: e.status });
    }
    console.error("[POST /api/caddies/reassign/preview]", e);
    return NextResponse.json(
      { error: "미리보기에 실패했습니다.", code: "preview_failed" },
      { status: 500 }
    );
  }
}
