// src/app/api/health/route.ts
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

export async function GET() {
  const out: any = { ok: true, checks: {} };

  // 1) 필수 ENV 존재 여부 (값은 마스킹)
  const has = (k: string) => (process.env[k] ? 'set' : 'missing');
  out.checks.env = {
    DATABASE_URL: has('DATABASE_URL'),
    NEXTAUTH_URL: has('NEXTAUTH_URL'),
    NEXTAUTH_SECRET: has('NEXTAUTH_SECRET'),
    ADMIN_PASSWORD: has('ADMIN_PASSWORD'),
    CADDY_PASSWORD: has('CADDY_PASSWORD'),
    NODE_ENV: process.env.NODE_ENV,
  };

  // 2) DB 연결 확인
  try {
    const [pong] = await prisma.$queryRawUnsafe<any[]>('SELECT 1 as ok');
    out.checks.db = { reachable: true, pong };
  } catch (e: any) {
    out.ok = false;
    out.checks.db = { reachable: false, error: e?.message };
  }

  // 3) 간단 조회
  try {
    const [{ count }] = await prisma.$queryRawUnsafe<{ count: number }[]>(
      'SELECT COUNT(*)::int AS count FROM "Notice";'
    );
    out.checks.noticeCount = count;
  } catch (e: any) {
    out.ok = false;
    out.checks.noticeCount = { error: e?.message };
  }

  return NextResponse.json(out, { status: out.ok ? 200 : 500 });
}
