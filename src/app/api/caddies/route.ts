import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { requireAdmin } from '@/lib/auth';

// GET /api/caddies?search=&page=1&pageSize=10
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const search = (searchParams.get('search') ?? '').trim();
    const page = Number(searchParams.get('page') ?? '1');
    const pageSize = Number(searchParams.get('pageSize') ?? '10');

    const where = search
      ? {
          OR: [
            { name: { contains: search } },
            { team: { contains: search } },
            { memo: { contains: search } },
          ],
        }
      : {};

    const [total, rows] = await Promise.all([
      prisma.caddy.count({ where }),
      prisma.caddy.findMany({
        where,
        orderBy: { id: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return NextResponse.json({ total, rows, page, pageSize });
  } catch (e: any) {
    console.error('[GET /api/caddies] error:', e);
    const payload =
      process.env.NODE_ENV === 'production'
        ? { error: 'Internal Server Error' }
        : { error: e?.message ?? 'error', stack: e?.stack };
    return NextResponse.json(payload, { status: 500 });
  }
}

// POST /api/caddies  (관리자만)
export async function POST(req: NextRequest) {
  try {
    requireAdmin(req);

    const body = await req.json();
    const { name, team, memo } = body ?? {};
    if (!name || typeof name !== 'string') {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }

    const created = await prisma.caddy.create({
      data: { name, team: team ?? '', memo: memo ?? null },
    });

    return NextResponse.json(created, { status: 201 });
  } catch (e: any) {
    console.error('[POST /api/caddies] error:', e);
    const status = e?.status ?? 500;
    const payload =
      process.env.NODE_ENV === 'production'
        ? { error: status === 401 ? 'Unauthorized' : 'Internal Server Error' }
        : { error: e?.message ?? 'error', stack: e?.stack };
    return NextResponse.json(payload, { status });
  }
}
