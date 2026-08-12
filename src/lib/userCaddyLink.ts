/**
 * Kakao User ↔ Caddy 1:1 수동 연결 (admin)
 * - write: User.caddyId 만
 * - kakaoUserId / username / password / role / managedTeams / Caddy 불변
 */

import { Prisma, type PrismaClient } from "@prisma/client";
import { normalizeAppRole } from "@/lib/sessionCookies";

export type DbClient = PrismaClient | Prisma.TransactionClient;

export class UserCaddyLinkError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number = 400,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "UserCaddyLinkError";
  }
}

export type LinkedCaddySummary = {
  id: number;
  name: string;
  team: string;
  teamOrder: number;
  employmentStatus: string;
};

export type KakaoUserListItem = {
  id: number;
  username: string;
  role: string;
  kakaoUserId: string;
  caddyId: number | null;
  linked: boolean;
  caddy: LinkedCaddySummary | null;
  createdAt: Date;
};

/** Kakao User만, admin 계정 제외 (role normalize 기준) */
export function isLinkableKakaoUser(user: {
  kakaoUserId: string | null;
  role: string;
}): boolean {
  if (user.kakaoUserId == null || String(user.kakaoUserId).trim() === "") {
    return false;
  }
  const role = normalizeAppRole(user.role);
  if (role === "admin") return false;
  return true;
}

export async function listKakaoUsersForAdmin(
  db: DbClient
): Promise<{
  users: KakaoUserListItem[];
  occupiedCaddyIds: number[];
}> {
  const [rows, occupied] = await Promise.all([
    db.user.findMany({
      where: { kakaoUserId: { not: null } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        username: true,
        role: true,
        kakaoUserId: true,
        caddyId: true,
        createdAt: true,
        caddy: {
          select: {
            id: true,
            name: true,
            team: true,
            teamOrder: true,
            employmentStatus: true,
          },
        },
      },
    }),
    db.user.findMany({
      where: { caddyId: { not: null } },
      select: { caddyId: true },
    }),
  ]);

  const users: KakaoUserListItem[] = rows
    .filter((u) => u.kakaoUserId != null)
    .filter((u) => isLinkableKakaoUser(u))
    .map((u) => ({
      id: u.id,
      username: u.username,
      role: u.role,
      kakaoUserId: u.kakaoUserId as string,
      caddyId: u.caddyId,
      linked: u.caddyId != null,
      caddy: u.caddy
        ? {
            id: u.caddy.id,
            name: u.caddy.name,
            team: u.caddy.team,
            teamOrder: u.caddy.teamOrder,
            employmentStatus: String(u.caddy.employmentStatus),
          }
        : null,
      createdAt: u.createdAt,
    }));

  const occupiedCaddyIds = occupied
    .map((o) => o.caddyId)
    .filter((id): id is number => typeof id === "number");

  return { users, occupiedCaddyIds };
}

export async function linkUserToCaddy(
  db: PrismaClient,
  userId: number,
  caddyId: number
): Promise<{ userId: number; caddyId: number }> {
  if (!Number.isFinite(userId) || userId <= 0) {
    throw new UserCaddyLinkError("invalid_user_id", "유효하지 않은 User id", 400);
  }
  if (!Number.isFinite(caddyId) || caddyId <= 0) {
    throw new UserCaddyLinkError("invalid_caddy_id", "유효하지 않은 Caddy id", 400);
  }

  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      kakaoUserId: true,
      role: true,
      caddyId: true,
    },
  });
  if (!user) {
    throw new UserCaddyLinkError("not_found", "사용자를 찾을 수 없습니다.", 404);
  }
  if (!isLinkableKakaoUser(user)) {
    throw new UserCaddyLinkError(
      "not_linkable_user",
      "Kakao 캐디 계정만 연결할 수 있습니다. (admin/비Kakao 제외)",
      403
    );
  }
  if (user.caddyId != null) {
    throw new UserCaddyLinkError(
      "already_linked",
      "이미 연결된 계정입니다. 다른 캐디로 바꾸려면 먼저 연결 해제하세요.",
      409,
      { caddyId: user.caddyId }
    );
  }

  const caddy = await db.caddy.findUnique({
    where: { id: caddyId },
    select: { id: true, employmentStatus: true, name: true, team: true },
  });
  if (!caddy) {
    throw new UserCaddyLinkError("caddy_not_found", "캐디를 찾을 수 없습니다.", 404);
  }
  if (String(caddy.employmentStatus) !== "ACTIVE") {
    throw new UserCaddyLinkError(
      "caddy_not_active",
      "ACTIVE 캐디만 연결할 수 있습니다.",
      409,
      { employmentStatus: caddy.employmentStatus }
    );
  }

  const holder = await db.user.findFirst({
    where: { caddyId },
    select: { id: true, username: true },
  });
  if (holder) {
    throw new UserCaddyLinkError(
      "caddy_already_linked",
      "이미 다른 계정에 연결된 캐디입니다.",
      409,
      { holderUserId: holder.id }
    );
  }

  try {
    // 조건부 update: 여전히 미연결일 때만 (동시성/교체 방지)
    const updated = await db.user.updateMany({
      where: {
        id: userId,
        caddyId: null,
        kakaoUserId: { not: null },
      },
      data: { caddyId },
    });
    if (updated.count !== 1) {
      throw new UserCaddyLinkError(
        "already_linked",
        "이미 연결된 계정이거나 연결할 수 없는 상태입니다.",
        409
      );
    }
  } catch (e) {
    if (e instanceof UserCaddyLinkError) throw e;
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === "P2002"
    ) {
      throw new UserCaddyLinkError(
        "caddy_already_linked",
        "이미 다른 계정에 연결된 캐디입니다.",
        409
      );
    }
    throw e;
  }

  return { userId, caddyId };
}

export async function unlinkUserFromCaddy(
  db: PrismaClient,
  userId: number
): Promise<{ userId: number; previousCaddyId: number | null }> {
  if (!Number.isFinite(userId) || userId <= 0) {
    throw new UserCaddyLinkError("invalid_user_id", "유효하지 않은 User id", 400);
  }

  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      kakaoUserId: true,
      role: true,
      caddyId: true,
    },
  });
  if (!user) {
    throw new UserCaddyLinkError("not_found", "사용자를 찾을 수 없습니다.", 404);
  }
  if (!isLinkableKakaoUser(user)) {
    throw new UserCaddyLinkError(
      "not_linkable_user",
      "Kakao 캐디 계정만 연결 해제할 수 있습니다.",
      403
    );
  }
  if (user.caddyId == null) {
    throw new UserCaddyLinkError(
      "not_linked",
      "연결되어 있지 않은 계정입니다.",
      409
    );
  }

  const previousCaddyId = user.caddyId;
  const updated = await db.user.updateMany({
    where: { id: userId, caddyId: previousCaddyId },
    data: { caddyId: null },
  });
  if (updated.count !== 1) {
    throw new UserCaddyLinkError(
      "not_linked",
      "연결 해제에 실패했습니다. 상태를 다시 확인해 주세요.",
      409
    );
  }

  return { userId, previousCaddyId };
}
