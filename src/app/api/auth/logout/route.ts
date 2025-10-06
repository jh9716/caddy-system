import { NextResponse } from 'next/server';

export async function POST() {
  const res = NextResponse.json({ ok:true });
  res.cookies.set('session_role', '', { path: '/', maxAge: 0 });
  res.cookies.set('session_user', '', { path: '/', maxAge: 0 });
  return res;
}
