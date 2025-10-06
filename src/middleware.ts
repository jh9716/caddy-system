import { NextRequest, NextResponse } from 'next/server';

const PUBLIC_PATHS = [
  '/login',
  '/api/auth/login',
  '/favicon.ico',
  '/_next',        // Next assets
  '/assets',       // static
];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // 퍼블릭 경로는 통과
  if (PUBLIC_PATHS.some(p => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  const role = req.cookies.get('session_role')?.value;
  const user = req.cookies.get('session_user')?.value;

  // 로그인 필요
  if (!role || !user) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    return NextResponse.redirect(url);
  }

  // 그 외는 통과 (세부 권한은 각 API/페이지에서 추가 검사)
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!.*\\.).*)'], // 모든 페이지/라우트 (정적 파일 제외)
};
