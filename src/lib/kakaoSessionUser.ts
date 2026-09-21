/**
 * Shared Kakao → User.kakaoUserId lookup / first-login provision.
 * REST callback and native-session (next step) must use this same policy.
 *
 * First-login: missing kakaoUserId → User.create role=caddy, password=null.
 * Existing User: DB role + sessionVersion kept. No email/nickname merge.
 */

import { Prisma } from "@prisma/client";
import { kakaoUsernameFromId } from "@/lib/kakaoOAuth";

export type KakaoSessionUserRow = {
  id: number;
  username: string;
  role: string;
  sessionVersion: number;
  caddyId: number | null;
  employmentStatus: string | null;
};

export type KakaoSessionUserDb = {
  user: {
    findUnique: (args: {
      where: { kakaoUserId: string };
      select: {
        id: true;
        username: true;
        role: true;
        sessionVersion: true;
        caddyId: true;
        caddy: { select: { employmentStatus: true } };
      };
    }) => Promise<{
      id: number;
      username: string;
      role: string;
      sessionVersion: number;
      caddyId: number | null;
      caddy: { employmentStatus: string } | null;
    } | null>;
    create: (args: {
      data: {
        username: string;
        password: null;
        role: "caddy";
        caddyId: null;
        managedTeams: [];
        kakaoUserId: string;
      };
      select: {
        id: true;
        username: true;
        role: true;
        sessionVersion: true;
        caddyId: true;
        caddy: { select: { employmentStatus: true } };
      };
    }) => Promise<{
      id: number;
      username: string;
      role: string;
      sessionVersion: number;
      caddyId: number | null;
      caddy: { employmentStatus: string } | null;
    }>;
  };
};

const USER_SELECT = {
  id: true,
  username: true,
  role: true,
  sessionVersion: true,
  caddyId: true,
  caddy: { select: { employmentStatus: true } },
} as const;

function mapRow(row: {
  id: number;
  username: string;
  role: string;
  sessionVersion: number;
  caddyId: number | null;
  caddy: { employmentStatus: string } | null;
}): KakaoSessionUserRow {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    sessionVersion: row.sessionVersion,
    caddyId: row.caddyId ?? null,
    employmentStatus: row.caddy?.employmentStatus ?? null,
  };
}

function isKakaoIdUniqueConflict(e: unknown): boolean {
  return (
    (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") ||
    (Boolean(e) &&
      typeof e === "object" &&
      (e as { code?: string }).code === "P2002")
  );
}

/**
 * Same first-login policy as historical REST `/api/auth/kakao/callback`.
 * Native-session must reuse this — do not invent a second User model.
 */
export async function findOrCreateKakaoSessionUser(
  db: KakaoSessionUserDb,
  kakaoUserId: string
): Promise<KakaoSessionUserRow | null> {
  const username = kakaoUsernameFromId(kakaoUserId);

  let row = await db.user.findUnique({
    where: { kakaoUserId },
    select: USER_SELECT,
  });

  if (!row) {
    try {
      row = await db.user.create({
        data: {
          username,
          password: null,
          role: "caddy",
          caddyId: null,
          managedTeams: [],
          kakaoUserId,
        },
        select: USER_SELECT,
      });
    } catch (e) {
      if (!isKakaoIdUniqueConflict(e)) throw e;
      row = await db.user.findUnique({
        where: { kakaoUserId },
        select: USER_SELECT,
      });
    }
  }

  return row ? mapRow(row) : null;
}
