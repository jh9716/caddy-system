// src/lib/auth.ts
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  clearSessionCookies,
  getVerifiedSessionFromCookies,
  normalizeAppRole,
  type AppRole,
  type VerifiedSession,
} from "@/lib/sessionCookies";
import {
  uniqueTeams,
  type OffRequestActor,
} from "@/lib/offRequestAuth";
import { shouldForcePasswordChange } from "@/lib/passwordPolicy";
import { isAccountManagerAuth } from "@/lib/staffAdminAccounts";

export type ResolvedAuthUser = {
  session: VerifiedSession;
  /** null for env-only accounts (no DB User row) */
  userId: number | null;
  username: string;
  /** Authorization role — from DB when userId present, else session claim */
  role: AppRole;
  sessionVersion: number;
  caddyId: number | null;
  managedTeams: string[];
  /** env-only (uid=null)는 항상 false. DB User만 최초 변경 강제. */
  mustChangePassword: boolean;
};

/** Prisma/DB 일시 오류. invalid session과 구분. 쿠키를 지우면 안 됨. */
export class AuthStoreUnavailableError extends Error {
  constructor(message = "auth store unavailable", options?: { cause?: unknown }) {
    super(message);
    this.name = "AuthStoreUnavailableError";
    if (options && "cause" in options) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

export function isAuthStoreUnavailable(e: unknown): boolean {
  return e instanceof AuthStoreUnavailableError;
}

export function authUnavailableResponse(): NextResponse {
  return NextResponse.json({ error: "auth_unavailable" }, { status: 503 });
}

/**
 * RETIRED linked Caddy blocks caddy/leader sessions only.
 * Admin stays authenticated even if an anomalous caddyId points at RETIRED.
 * LEAVE is allowed. Unlinked (caddyId=null) is allowed (→ /caddy/link).
 */
export function isRetiredCaddySessionBlocked(input: {
  role: AppRole;
  caddyId: number | null;
  employmentStatus?: string | null;
}): boolean {
  if (input.role !== "caddy" && input.role !== "leader") return false;
  if (input.caddyId == null) return false;
  return String(input.employmentStatus ?? "").trim().toUpperCase() === "RETIRED";
}

/**
 * Full auth resolution for Node runtime (API / RSC).
 * - Requires valid signed vh_session
 * - Legacy unsigned cookies alone → null
 * - DB user: role + sessionVersion must match
 */
export async function resolveAuthUser(
  req: NextRequest
): Promise<ResolvedAuthUser | null> {
  return resolveAuthFromCookieStore(req.cookies);
}

/** RSC / layout: next/headers cookies() */
export async function resolveAuthFromCookieStore(cookies: {
  get: (name: string) => { value: string } | undefined;
}): Promise<ResolvedAuthUser | null> {
  const session = await getVerifiedSessionFromCookies(cookies);
  if (!session) return null;

  if (session.uid == null) {
    return {
      session,
      userId: null,
      username: session.username,
      role: session.role,
      sessionVersion: session.sv,
      caddyId: null,
      managedTeams: [],
      mustChangePassword: false,
    };
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: session.uid },
      select: {
        id: true,
        username: true,
        role: true,
        sessionVersion: true,
        caddyId: true,
        managedTeams: true,
        mustChangePassword: true,
        caddy: { select: { employmentStatus: true } },
      },
    });
    if (!user) return null;
    if (user.username !== session.username) return null;
    if (user.sessionVersion !== session.sv) return null;
    const dbRole = normalizeAppRole(user.role);
    if (!dbRole) return null;
    if (
      isRetiredCaddySessionBlocked({
        role: dbRole,
        caddyId: user.caddyId ?? null,
        employmentStatus: user.caddy?.employmentStatus ?? null,
      })
    ) {
      return null;
    }

    return {
      session,
      userId: user.id,
      username: user.username,
      role: dbRole,
      sessionVersion: user.sessionVersion,
      caddyId: user.caddyId ?? null,
      managedTeams: uniqueTeams(user.managedTeams ?? []),
      mustChangePassword: user.mustChangePassword === true,
    };
  } catch (e) {
    if (e instanceof AuthStoreUnavailableError) throw e;
    console.error("[resolveAuthFromCookieStore]", e);
    throw new AuthStoreUnavailableError("auth store unavailable", { cause: e });
  }
}

/**
 * 관리자만. 서명 세션 + (DB User면) DB role=admin + sessionVersion 일치.
 * 사용법: const guard = await requireAdmin(req); if (guard) return guard;
 */
export function mustChangePasswordResponse(): NextResponse {
  return NextResponse.json(
    {
      error: "MUST_CHANGE_PASSWORD",
      message: "비밀번호를 변경한 뒤 이용할 수 있습니다.",
    },
    { status: 403 }
  );
}

export function canPublishDailyBoard(role: AppRole | null | undefined): boolean {
  return role === "admin";
}

/** 공용 배치표(Published) 조회. Draft/publish 쓰기는 포함하지 않는다. */
export function canReadPublishedBoard(role: AppRole | null | undefined): boolean {
  return role === "admin" || role === "caddy" || role === "leader";
}

export async function requireAdmin(
  req: NextRequest
): Promise<NextResponse | void> {
  let auth: ResolvedAuthUser | null;
  try {
    auth = await resolveAuthUser(req);
  } catch (e) {
    if (isAuthStoreUnavailable(e)) return authUnavailableResponse();
    throw e;
  }
  if (!auth || auth.role !== "admin") {
    const res = NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (!auth) clearSessionCookies(res, req);
    return res;
  }
  if (shouldForcePasswordChange(auth)) {
    return mustChangePasswordResponse();
  }
}

/** 로그인 경기과/캐디/조장 — Published GET 전용. Draft API에는 쓰지 말 것. */
export async function requirePublishedReader(
  req: NextRequest
): Promise<NextResponse | void> {
  let auth: ResolvedAuthUser | null;
  try {
    auth = await resolveAuthUser(req);
  } catch (e) {
    if (isAuthStoreUnavailable(e)) return authUnavailableResponse();
    throw e;
  }
  if (!auth || !canReadPublishedBoard(auth.role)) {
    const res = NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (!auth) clearSessionCookies(res, req);
    return res;
  }
  if (shouldForcePasswordChange(auth)) {
    return mustChangePasswordResponse();
  }
}

/** 직원 계정 관리 전용. 운영 requireAdmin과 분리. schema/role 변경 없음. */
export function forbiddenAccountManagerResponse(): NextResponse {
  return NextResponse.json(
    {
      error: "forbidden",
      message: "최고관리자만 직원 계정을 관리할 수 있습니다.",
    },
    { status: 403 }
  );
}

export async function requireSuperAdmin(
  req: NextRequest
): Promise<NextResponse | void> {
  return requireAccountManager(req);
}

export async function requireAccountManager(
  req: NextRequest
): Promise<NextResponse | void> {
  const adminGuard = await requireAdmin(req);
  if (adminGuard) return adminGuard;
  const auth = await resolveAuthUser(req);
  if (!auth || !isAccountManagerAuth(auth)) {
    return forbiddenAccountManagerResponse();
  }
}

export type { OffRequestActor };

/**
 * 쿠키 + DB User 로 OffRequest Actor 구성.
 * 환경변수 로그인( DB User 없음 )도 role/username 만으로 Actor 구성.
 */
export async function resolveOffRequestActor(
  req: NextRequest
): Promise<OffRequestActor | null> {
  const auth = await resolveAuthUser(req);
  if (!auth) return null;

  return {
    role: auth.role,
    username: auth.username,
    userId: auth.userId,
    caddyId: auth.caddyId,
    managedTeams: auth.managedTeams,
  };
}

export async function requireOffRequestActor(
  req: NextRequest
): Promise<OffRequestActor | NextResponse> {
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
  if (shouldForcePasswordChange(auth)) {
    return mustChangePasswordResponse();
  }

  return {
    role: auth.role,
    username: auth.username,
    userId: auth.userId,
    caddyId: auth.caddyId,
    managedTeams: auth.managedTeams,
  };
}

export function isActorResponse(
  v: OffRequestActor | NextResponse
): v is NextResponse {
  return v instanceof NextResponse;
}

export function requireRole(
  actor: OffRequestActor,
  roles: AppRole[]
): NextResponse | void {
  if (!roles.includes(actor.role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
}
