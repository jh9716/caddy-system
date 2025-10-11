import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'

// .env 값 읽기
const CADDY_USERNAME = process.env.CADDY_USERNAME || 'caddy'
const CADDY_PASSWORD = process.env.CADDY_PASSWORD || '1234'
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin'
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '1111'

// 쿠키 유틸
function setAuthCookie(role: 'caddy'|'admin') {
  const res = NextResponse.json({ ok: true, role })
  // 필요시 secure: true 는 로컬에서 빼고, prod에서만 쓰세요.
  res.cookies.set('role', role, { httpOnly: true, sameSite: 'lax', path: '/' })
  return res
}

export async function POST(req: NextRequest) {
  try {
    const { id, password } = await req.json()

    const uid = String(id || '').trim().toLowerCase()
    const pw  = String(password || '').trim()

    // 관리자 먼저 체크
    if (uid === ADMIN_USERNAME.toLowerCase() && pw === ADMIN_PASSWORD) {
      return setAuthCookie('admin')
    }

    // 캐디 체크
    if (uid === CADDY_USERNAME.toLowerCase() && pw === CADDY_PASSWORD) {
      return setAuthCookie('caddy')
    }

    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  } catch (e: any) {
    console.error('[POST /api/login] error', e)
    return NextResponse.json({ error: 'login failed' }, { status: 400 })
  }
}
