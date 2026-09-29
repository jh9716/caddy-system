import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import {
  isAllowedAssignmentType,
  isValidDateRange,
  parseAssignmentYmd,
  parsePositiveInt,
} from "@/lib/legacyAssignmentApi";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CADDY_LABEL_SELECT = {
  id: true,
  name: true,
  team: true,
  caddyType: true,
} as const;

// POST: 기간 지정 생성 (관리자 전용 legacy)
export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard) return guard;

  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "JSON body 필요" }, { status: 400 });
    }

    const { caddyId, type, startDate, endDate } = body as Record<string, unknown>;
    const parsedCaddyId = parsePositiveInt(caddyId);
    const start = parseAssignmentYmd(startDate);
    const end = parseAssignmentYmd(endDate);

    if (!parsedCaddyId || !type || !start || !end) {
      return NextResponse.json(
        { error: "필수 값이 누락되었거나 형식이 올바르지 않습니다." },
        { status: 400 }
      );
    }
    if (!isAllowedAssignmentType(type)) {
      return NextResponse.json(
        { error: "허용되지 않은 assignment type입니다." },
        { status: 400 }
      );
    }
    if (!isValidDateRange(start.date, end.date)) {
      return NextResponse.json(
        { error: "종료일은 시작일 이후여야 합니다." },
        { status: 400 }
      );
    }

    const exists = await prisma.caddy.findUnique({
      where: { id: parsedCaddyId },
      select: { id: true },
    });
    if (!exists) {
      return NextResponse.json(
        { error: "존재하지 않는 캐디입니다." },
        { status: 404 }
      );
    }

    const created = await prisma.assignment.create({
      data: {
        caddyId: parsedCaddyId,
        type,
        startDate: start.date,
        endDate: end.date,
      },
    });

    return NextResponse.json(created);
  } catch (e: any) {
    console.error("Assignment POST Error:", e);
    return NextResponse.json(
      { error: e?.message || "등록 실패" },
      { status: 500 }
    );
  }
}

// GET: 기간 지정 목록 (관리자 전용. caddyId 없으면 전체)
export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard) return guard;

  try {
    const { searchParams } = new URL(req.url);
    const rawCaddyId = searchParams.get("caddyId");
    const where: { caddyId?: number } = {};

    if (rawCaddyId != null && rawCaddyId !== "") {
      const caddyId = parsePositiveInt(rawCaddyId);
      if (!caddyId) {
        return NextResponse.json({ error: "caddyId 필요" }, { status: 400 });
      }
      where.caddyId = caddyId;
    }

    const list = await prisma.assignment.findMany({
      where,
      include: { caddy: { select: CADDY_LABEL_SELECT } },
      orderBy: [{ startDate: "desc" }],
    });

    return NextResponse.json(list);
  } catch (e: any) {
    console.error("Assignment GET Error:", e);
    return NextResponse.json(
      { error: e?.message || "조회 실패" },
      { status: 500 }
    );
  }
}
