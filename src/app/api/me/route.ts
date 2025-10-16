// app/api/me/route.ts
import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '../auth/[...nextauth]/route'  // ✅ 상대경로로!

export const dynamic = 'force-dynamic'

export async function GET() {
  const session = await getServerSession(authOptions)
  return NextResponse.json({
    ok: true,
    session,                      // 세션 확인용
  })
}
