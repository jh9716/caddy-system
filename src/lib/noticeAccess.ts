import { NextRequest, NextResponse } from "next/server";
import type { PrismaClient } from "@prisma/client";
import {
  authUnavailableResponse,
  isAuthStoreUnavailable,
  mustChangePasswordResponse,
  resolveAuthUser,
  type ResolvedAuthUser,
} from "@/lib/auth";
import { shouldForcePasswordChange } from "@/lib/passwordPolicy";
import { clearSessionCookies } from "@/lib/sessionCookies";
import type { NoticeViewer } from "@/lib/noticeTarget";

export function canReadInternalNotice(
  role: ResolvedAuthUser["role"] | null | undefined
): boolean {
  return role === "admin" || role === "caddy" || role === "leader";
}

export function canWriteInternalNotice(
  role: ResolvedAuthUser["role"] | null | undefined
): boolean {
  return role === "admin";
}

export async function loadNoticeViewer(
  db: PrismaClient,
  auth: ResolvedAuthUser
): Promise<NoticeViewer> {
  if (auth.caddyId == null) {
    return {
      role: auth.role,
      caddyId: null,
      caddyType: null,
      team: null,
    };
  }
  const caddy = await db.caddy.findUnique({
    where: { id: auth.caddyId },
    select: { caddyType: true, team: true },
  });
  return {
    role: auth.role,
    caddyId: auth.caddyId,
    caddyType: caddy?.caddyType ?? null,
    team: caddy?.team ?? null,
  };
}

export function isNoticeAuthResponse(
  v: ResolvedAuthUser | NextResponse
): v is NextResponse {
  return v instanceof NextResponse;
}

/**
 * Login required: caddy / leader / admin.
 * Unauth → 401. Logged-in other role → 401 (same as published board reader).
 */
export async function requireNoticeReader(
  req: NextRequest
): Promise<ResolvedAuthUser | NextResponse> {
  let auth: ResolvedAuthUser | null;
  try {
    auth = await resolveAuthUser(req);
  } catch (e) {
    if (isAuthStoreUnavailable(e)) return authUnavailableResponse();
    throw e;
  }
  if (!auth || !canReadInternalNotice(auth.role)) {
    const res = NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (!auth) clearSessionCookies(res, req);
    return res;
  }
  if (shouldForcePasswordChange(auth)) {
    return mustChangePasswordResponse();
  }
  return auth;
}

/** Unauth 401, logged-in non-admin 403. Push preview/send 전용. */
export async function requireNoticeAdmin(
  req: NextRequest
): Promise<ResolvedAuthUser | NextResponse> {
  let auth: ResolvedAuthUser | null;
  try {
    auth = await resolveAuthUser(req);
  } catch (e) {
    if (isAuthStoreUnavailable(e)) return authUnavailableResponse();
    throw e;
  }
  if (!auth) {
    const res = NextResponse.json({ error: "unauthorized" }, { status: 401 });
    clearSessionCookies(res, req);
    return res;
  }
  if (auth.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (shouldForcePasswordChange(auth)) {
    return mustChangePasswordResponse();
  }
  return auth;
}
