// src/utils/requireAdmin.ts
import { cookies } from 'next/headers';

const ADMIN_COOKIE = 'admin';

export function isAdmin() {
  const c = cookies().get(ADMIN_COOKIE);
  return c?.value === '1';
}

// ✅ named export "requireAdmin" 로 정확히 내보내기
export function requireAdmin() {
  if (!isAdmin()) {
    const err = new Error('unauthorized');
    // @ts-expect-error attach status for route handlers
    err.status = 401;
    throw err;
  }
}
