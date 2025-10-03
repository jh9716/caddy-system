// src/app/api/assignments/route.ts
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function GET() {
  const items = await prisma.assignment.findMany({
    orderBy: [{ 조: 'asc' }, { 성함: 'asc' }],
  });
  return NextResponse.json({ items });
}
