// src/app/api/assignments/[id]/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireAdmin } from '@/lib/auth';

// 단일 조회 (필요 없으면 이 GET 자체를 지워도 됩니다)
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const id = Number(params.id);
  if (Number.isNaN(id)) {
    return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  }
  const row = await prisma.assignment.findUnique({
    where: { id },
    include: { caddy: true },
  });
  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(row);
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const guard = requireAdmin(req); if (guard) return guard;

  const id = Number(params.id);
  if (Number.isNaN(id)) {
    return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  }
  const data = await req.json();
  const updated = await prisma.assignment.update({ where: { id }, data });
  return NextResponse.json(updated);
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const guard = requireAdmin(req); if (guard) return guard;

  const id = Number(params.id);
  if (Number.isNaN(id)) {
    return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  }
  await prisma.assignment.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
