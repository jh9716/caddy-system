import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import {
  applySessionCookies,
  normalizeAppRole,
  type AppRole,
} from '@/lib/sessionCookies';
import { verifyUserPassword } from '@/lib/userPassword';

export async function POST(req: NextRequest) {
  const { username, password } = await req.json();

  const caddyUser = process.env.CADDY_USERNAME || process.env.CADDY_USER || 'caddy';
  const caddyPass = process.env.CADDY_PASSWORD || 'caddy1234';
  const adminUser = process.env.ADMIN_USERNAME || process.env.ADMIN_USER || 'admin';
  const adminPass = process.env.ADMIN_PASSWORD || '';

  let role: AppRole | null = null;

  if (username === caddyUser && password === caddyPass) {
    role = 'caddy';
  } else if (username === adminUser && adminPass && password === adminPass) {
    role = 'admin';
  } else {
    const user = await prisma.user.findUnique({ where: { username }});
    if (!user) {
      return NextResponse.json({ ok:false, message:'존재하지 않거나 권한이 없습니다.' }, { status: 401 });
    }
    // password null(OAuth 전용) → bcrypt 미호출, 401
    const ok = await verifyUserPassword(password, user.password);
    if (!ok) {
      return NextResponse.json({ ok:false, message:'비밀번호가 올바르지 않습니다.' }, { status: 401 });
    }
    role = normalizeAppRole(user.role);
    if (!role) {
      return NextResponse.json({ ok:false, message:'존재하지 않거나 권한이 없습니다.' }, { status: 401 });
    }
  }

  const res = NextResponse.json({ ok:true, message:'로그인 성공', role });
  applySessionCookies(res, req, role!, username);
  return res;
}
