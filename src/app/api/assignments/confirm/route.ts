import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { applyConfirmedAssignments } from "@/lib/assignmentConfirmApply";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/assignments/confirm
 * CONFIRMED 배치표만 Schedule / ShiftDuty / ExtraTag 에 반영
 * - admin 권한 필수
 * - DRAFT/EDITED 거부
 * - 없는 caddyId 거부
 * - 같은 날짜 기존 배치 → replace:true 명시 승인 필요
 * - transaction + 중복 payload 방지
 * - 성공 시 Audit 기록, status APPLIED
 */
export async function POST(req: NextRequest) {
  const guard = requireAdmin(req);
  if (guard) return guard;

  try {
    const body = await req.json().catch(() => null);
    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      req.headers.get("x-real-ip") ||
      null;

    const result = await applyConfirmedAssignments(body, { ip });

    if (!result.ok) {
      return NextResponse.json(
        {
          error: result.message,
          code: result.code,
          issues: result.issues,
          existing: result.existing,
          requireReplace: result.requireReplace,
        },
        { status: result.httpStatus }
      );
    }

    return NextResponse.json(result);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "confirm 실패";
    console.error("[POST /api/assignments/confirm]", e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
