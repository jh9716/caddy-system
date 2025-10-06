// src/utils/requireAdmin.ts

import { NextRequest, NextResponse } from 'next/server';

// 간단한 관리자 인증 예시 (쿠키나 헤더 기반)
export async function requireAdmin(req: NextRequest) {
  const cookie = req.cookies.get('admin');
  if (!cookie || cookie.value !== process.env.ADMIN_SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  return null;
}
