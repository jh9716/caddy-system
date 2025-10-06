import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import bcrypt from 'bcryptjs';

export async function POST(req: NextRequest) {
  const { username, password } = await req.json();

  // 1) 캐디 공용 계정
  const caddyUser = process.env.CADDY_USERNAME || 'caddy';
  const caddyPass = process.env.CADDY_PASSWORD || 'caddy1234';

  let role: 'admin' | 'caddy' | null = null;

  if (username === caddyUser) {
    if (password !== caddyPass) {
      return NextResponse.json({ ok:false, message:'비밀번호가 올바르지 않습니다.' }, { status: 401 });
    }
    role = 'caddy';
  } else {
    // 2) 관리자 계정
    const user = await prisma.user.findUnique({ where: { username }});
    if (!user || user.role !== 'admin') {
      return NextResponse.json({ ok:false, message:'존재하지 않거나 권한이 없습니다.' }, { status: 401 });
    }
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) {
      return NextResponse.json({ ok:false, message:'비밀번호가 올바르지 않습니다.' }, { status: 401 });
    }
    role = 'admin';
  }

  const res = NextResponse.json({ ok:true, message:'로그인 성공' });
  const secure = process.env.NODE_ENV === 'production';

  res.cookies.set('session_role', role!, { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: 60*60*8 });
  res.cookies.set('session_user', username, { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: 60*60*8 });

  return res;
}
