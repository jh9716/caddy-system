// src/lib/auth.ts
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  getRoleFromCookies,
  getUsernameFromCookies,
  normalizeAppRole,
  type AppRole,
} from "@/lib/sessionCookies";
import {
  uniqueTeams,
  type OffRequestActor,
} from "@/lib/offRequestAuth";

/**
 * 관리자 쿠키가 없으면 401을 반환합니다.
 * 사용법: const guard = requireAdmin(req); if (guard) return guard;
 */
export function requireAdmin(req: NextRequest): NextResponse | void {
  const role = getRoleFromCookies(req.cookies);
  if (role !== "admin") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
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
  const role = getRoleFromCookies(req.cookies);
  const username = getUsernameFromCookies(req.cookies);
  if (!role || !username) return null;

  try {
    const user = await prisma.user.findUnique({
      where: { username },
      select: {
        id: true,
        role: true,
        caddyId: true,
        managedTeams: true,
      },
    });

    if (user) {
      const dbRole = normalizeAppRole(user.role) || role;
      return {
        role: dbRole,
        username,
        userId: user.id,
        caddyId: user.caddyId ?? null,
        managedTeams: uniqueTeams(user.managedTeams ?? []),
      };
    }
  } catch (e) {
    console.error("[resolveOffRequestActor]", e);
  }

  // 환경변수 계정 등 DB User 없음
  return {
    role,
    username,
    userId: null,
    caddyId: null,
    managedTeams: [],
  };
}

export async function requireOffRequestActor(
  req: NextRequest
): Promise<OffRequestActor | NextResponse> {
  const actor = await resolveOffRequestActor(req);
  if (!actor) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
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
