// src/app/api/caddies/[id]/route.ts
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// PUT /api/caddies/:id : 수정
export async function PUT(
  req: Request,
  { params }: { params: { id: string } }
) {
  try {
    const id = Number(params.id);
    if (Number.isNaN(id)) {
      return NextResponse.json({ error: "잘못된 id" }, { status: 400 });
    }
    const body = await req.json();
    const { name, team, status } = body ?? {};
    const updated = await prisma.caddy.update({
      where: { id },
      data: { ...(name && { name }), ...(team && { team }), ...(status && { status }) },
    });
    return NextResponse.json(updated);
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Failed to update" }, { status: 500 });
  }
}

// DELETE /api/caddies/:id : 삭제
export async function DELETE(
  _req: Request,
  { params }: { params: { id: string } }
) {
  try {
    const id = Number(params.id);
    if (Number.isNaN(id)) {
      return NextResponse.json({ error: "잘못된 id" }, { status: 400 });
    }
    await prisma.caddy.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Failed to delete" }, { status: 500 });
  }
}
