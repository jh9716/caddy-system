import { NextRequest, NextResponse } from "next/server";
import {
  authUnavailableResponse,
  isAuthStoreUnavailable,
  mustChangePasswordResponse,
  resolveAuthUser,
  type ResolvedAuthUser,
} from "@/lib/auth";
import { shouldForcePasswordChange } from "@/lib/passwordPolicy";
import { clearSessionCookies } from "@/lib/sessionCookies";
import type { CourseReportStatusCode } from "@/lib/courseReportConstants";

export function canReadCourseReport(
  role: ResolvedAuthUser["role"] | null | undefined
): boolean {
  return role === "admin" || role === "caddy" || role === "leader";
}

export function canWriteCourseReport(
  role: ResolvedAuthUser["role"] | null | undefined
): boolean {
  return canReadCourseReport(role);
}

export function isCourseReportAuthResponse(
  v: ResolvedAuthUser | NextResponse
): v is NextResponse {
  return v instanceof NextResponse;
}

/**
 * Login required: caddy / leader / admin.
 * Unauth → 401. Logged-in other role → 401.
 * RETIRED caddy/leader already null from resolveAuthUser.
 */
export async function requireCourseReportReader(
  req: NextRequest
): Promise<ResolvedAuthUser | NextResponse> {
  let auth: ResolvedAuthUser | null;
  try {
    auth = await resolveAuthUser(req);
  } catch (e) {
    if (isAuthStoreUnavailable(e)) return authUnavailableResponse();
    throw e;
  }
  if (!auth || !canReadCourseReport(auth.role)) {
    const res = NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (!auth) clearSessionCookies(res, req);
    return res;
  }
  if (shouldForcePasswordChange(auth)) {
    return mustChangePasswordResponse();
  }
  return auth;
}

export async function requireCourseReportWriter(
  req: NextRequest
): Promise<ResolvedAuthUser | NextResponse> {
  return requireCourseReportReader(req);
}

export function canEditCourseReportContent(input: {
  role: ResolvedAuthUser["role"];
  userId: number | null;
  authorUserId: number;
  status: CourseReportStatusCode | string;
  deletedAt: Date | null;
}): boolean {
  if (input.deletedAt) return false;
  if (input.role === "admin") return true;
  if (input.userId == null || input.userId !== input.authorUserId) return false;
  return input.status === "RECEIVED";
}

export function canSoftDeleteCourseReport(input: {
  role: ResolvedAuthUser["role"];
  userId: number | null;
  authorUserId: number;
  status: CourseReportStatusCode | string;
  deletedAt: Date | null;
}): boolean {
  return canEditCourseReportContent(input);
}

export function canChangeCourseReportStatus(input: {
  role: ResolvedAuthUser["role"];
  deletedAt: Date | null;
}): boolean {
  if (input.deletedAt) return false;
  return input.role === "admin";
}
