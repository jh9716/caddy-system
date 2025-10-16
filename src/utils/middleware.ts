// src/middleware.ts
export { default } from "next-auth/middleware";

// 로그인만 필수인 경로
export const config = {
  matcher: [
    "/manage/:path*",  // 관리자 대시보드 등
    "/caddy/:path*",   // 캐디 전용 화면
  ],
};
