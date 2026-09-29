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

async function resolveId(
  params: Promise<{ id: string }> | { id: string }
): Promise<number | null> {
  const resolved = await Promise.resolve(params);
  return parsePositiveInt(resolved.id);
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> | { id: string } }
) {
  const guard = await requireAdmin(req);
  if (guard) return guard;

  try {
    const id = await resolveId(ctx.params);
    if (!id) {
      return NextResponse.json({ error: "잘못된 id" }, { status: 400 });
    }

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "JSON body 필요" }, { status: 400 });
    }

    const existing = await prisma.assignment.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json(
        { error: "존재하지 않는 일정입니다." },
        { status: 404 }
      );
    }

    const data: {
      type?: typeof existing.type;
      subType?: string | null;
      startDate?: Date;
      endDate?: Date;
      comment?: string | null;
    } = {};

    if (body.type !== undefined) {
      if (!isAllowedAssignmentType(body.type)) {
        return NextResponse.json(
          { error: "허용되지 않은 assignment type입니다." },
          { status: 400 }
        );
      }
      data.type = body.type;
    }
    if (body.subType !== undefined) {
      data.subType =
        body.subType == null ? null : String(body.subType);
    }
    if (body.comment !== undefined) {
      data.comment =
        body.comment == null ? null : String(body.comment);
    }
    if (body.startDate !== undefined) {
      const start = parseAssignmentYmd(body.startDate);
      if (!start) {
        return NextResponse.json(
          { error: "시작일 형식이 올바르지 않습니다." },
          { status: 400 }
        );
      }
      data.startDate = start.date;
    }
    if (body.endDate !== undefined) {
      const end = parseAssignmentYmd(body.endDate);
      if (!end) {
        return NextResponse.json(
          { error: "종료일 형식이 올바르지 않습니다." },
          { status: 400 }
        );
      }
      data.endDate = end.date;
    }

    const nextStart = data.startDate ?? existing.startDate;
    const nextEnd = data.endDate ?? existing.endDate;
    if (!isValidDateRange(nextStart, nextEnd)) {
      return NextResponse.json(
        { error: "종료일은 시작일 이후여야 합니다." },
        { status: 400 }
      );
    }

    const updated = await prisma.assignment.update({
      where: { id },
      data,
    });
    return NextResponse.json(updated);
  } catch (e: any) {
    console.error("PATCH /api/assignments/[id] error:", e);
    return NextResponse.json(
      { error: e?.message ?? "수정 실패" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> | { id: string } }
) {
  const guard = await requireAdmin(req);
  if (guard) return guard;

  try {
    const id = await resolveId(ctx.params);
    if (!id) {
      return NextResponse.json({ error: "잘못된 id" }, { status: 400 });
    }

    const existing = await prisma.assignment.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing) {
      return NextResponse.json(
        { error: "존재하지 않는 일정입니다." },
        { status: 404 }
      );
    }

    await prisma.assignment.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error("DELETE /api/assignments/[id] error:", e);
    return NextResponse.json(
      { error: e?.message ?? "삭제 실패" },
      { status: 500 }
    );
  }
}
