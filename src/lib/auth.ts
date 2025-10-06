// src/lib/auth.ts
import { NextRequest, NextResponse } from 'next/server';

/**
 * 관리자 쿠키(admin=1)가 없으면 401을 반환합니다.
 * 사용법: const guard = requireAdmin(req); if (guard) return guard;
 */
export function requireAdmin(req: NextRequest): NextResponse | void {
  const isAdmin = req.cookies.get('admin')?.value === '1';
  if (!isAdmin) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
}
