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
};

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
      },
    });
    if (!user) return null;
    if (user.username !== session.username) return null;
    if (user.sessionVersion !== session.sv) return null;
    const dbRole = normalizeAppRole(user.role);
    if (!dbRole) return null;

    return {
      session,
      userId: user.id,
      username: user.username,
      role: dbRole,
      sessionVersion: user.sessionVersion,
      caddyId: user.caddyId ?? null,
      managedTeams: uniqueTeams(user.managedTeams ?? []),
    };
  } catch (e) {
    console.error("[resolveAuthFromCookieStore]", e);
    return null;
  }
}

/**
 * 관리자만. 서명 세션 + (DB User면) DB role=admin + sessionVersion 일치.
 * 사용법: const guard = await requireAdmin(req); if (guard) return guard;
 */
export async function requireAdmin(
  req: NextRequest
): Promise<NextResponse | void> {
  const auth = await resolveAuthUser(req);
  if (!auth || auth.role !== "admin") {
    const res = NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (!auth) clearSessionCookies(res, req);
    return res;
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
  const actor = await resolveOffRequestActor(req);
  if (!actor) {
    const res = NextResponse.json({ error: "unauthorized" }, { status: 401 });
    clearSessionCookies(res, req);
    return res;
  }
  return actor;
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
