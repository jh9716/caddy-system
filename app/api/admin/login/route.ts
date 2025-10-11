import { NextResponse } from 'next/server'

export async function POST(req: Request) {
  try {
    const { password } = await req.json()
    if (!password || password !== process.env.ADMIN_PASSWORD) {
      return NextResponse.json({ ok: false, error: 'INVALID_PASSWORD' }, { status: 401 })
    }
    const res = NextResponse.json({ ok: true })
    // 로그인 쿠키(로컬 개발용)
    res.cookies.set('admin', '1', {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 60 * 60 * 12, // 12시간
      path: '/',
    })
    return res
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 400 })
  }
}
