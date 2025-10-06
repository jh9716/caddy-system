import { NextRequest, NextResponse } from 'next/server';

const ADMIN_COOKIE = 'admin';

export async function POST(req: NextRequest) {
  const { password } = await req.json();
  if (!password || password !== process.env.ADMIN_PASSWORD) {
    return NextResponse.json(
      { ok: false, message: '비밀번호가 올바르지 않습니다.' },
      { status: 401 }
    );
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(ADMIN_COOKIE, '1', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production', // 개발환경에서는 false
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 8, // 8시간
  });
  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(ADMIN_COOKIE, '', { path: '/', maxAge: 0 });
  return res;
}
