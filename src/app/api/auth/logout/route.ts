import { NextRequest, NextResponse } from 'next/server';
import { clearSessionCookies } from '@/lib/sessionCookies';

export async function POST(req: NextRequest) {
  const res = NextResponse.json({ ok:true });
  clearSessionCookies(res, req);
  return res;
}
