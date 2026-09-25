/**
 * Google Play 심사용 계정 생성/비활성화.
 *
 * 기본은 DRY-RUN. --apply + --confirm 없이 INSERT/UPDATE/DELETE 없음.
 * 비밀번호는 PLAY_REVIEW_ADMIN_PASSWORD / PLAY_REVIEW_CADDY_PASSWORD 만 사용.
 * 원문/해시는 출력하지 않는다. username=admin 및 실제 직원은 수정하지 않는다.
 *
 * Dry-run:
 *   DATABASE_URL=postgresql://caddy:caddy@localhost:5432/caddy_local \
 *     npx tsx scripts/maintenance/play-review-accounts.ts
 *
 * Local create:
 *   PLAY_REVIEW_ADMIN_PASSWORD=... PLAY_REVIEW_CADDY_PASSWORD=... \
 *   DATABASE_URL=postgresql://caddy:caddy@localhost:5432/caddy_local \
 *     npx tsx scripts/maintenance/play-review-accounts.ts \
 *     --apply --confirm=CREATE_PLAY_REVIEW_ACCOUNTS
 *
 * Production create (명시 승인 후에만):
 *   PLAY_REVIEW_ADMIN_PASSWORD=... PLAY_REVIEW_CADDY_PASSWORD=... \
 *   PROD_MAINTENANCE_CONFIRM=CREATE_PLAY_REVIEW_ACCOUNTS \
 *   DATABASE_URL=... \
 *     npx tsx scripts/maintenance/play-review-accounts.ts \
 *     --apply --confirm=CREATE_PLAY_REVIEW_ACCOUNTS
 *
 * Disable:
 *   ... --disable --apply --confirm=DISABLE_PLAY_REVIEW_ACCOUNTS
 */
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../../src/lib/userPassword";
import {
  PLAY_REVIEW_ADMIN_PASSWORD_ENV,
  PLAY_REVIEW_ADMIN_USERNAME,
  PLAY_REVIEW_CADDY_MEMO,
  PLAY_REVIEW_CADDY_NAME,
  PLAY_REVIEW_CADDY_PASSWORD_ENV,
  PLAY_REVIEW_CADDY_USERNAME,
  PLAY_REVIEW_CREATE_CONFIRM,
  PLAY_REVIEW_DISABLE_CONFIRM,
  canWritePlayReview,
  formatPlayReviewReport,
  isForbiddenUserWrite,
  isPlayReviewUsername,
  parsePlayReviewArgs,
  planPlayReviewCreate,
  planPlayReviewDisable,
  readPlayReviewPassword,
  type InspectedReviewCaddy,
  type InspectedReviewUser,
  type PlayReviewSnapshot,
} from "../../src/lib/playReviewAccounts";
import { DRIVING_POOL_TEAM } from "../../src/lib/caddyManage";
import {
  assertLocalDatabaseUrl,
  isProductionDatabaseUrl,
} from "../assertLocalDatabaseUrl";
import { requireProdMaintenance } from "../requireProdMaintenance";

const USER_SELECT = {
  id: true,
  username: true,
  role: true,
  kakaoUserId: true,
  caddyId: true,
  mustChangePassword: true,
  managedTeams: true,
  password: true,
} as const;

function mapUser(row: {
  id: number;
  username: string;
  role: string;
  kakaoUserId: string | null;
  caddyId: number | null;
  mustChangePassword: boolean;
  managedTeams: string[];
  password: string | null;
}): InspectedReviewUser {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    kakaoUserId: row.kakaoUserId,
    caddyId: row.caddyId,
    mustChangePassword: row.mustChangePassword,
    managedTeams: row.managedTeams ?? [],
    passwordPresent: typeof row.password === "string" && row.password.length > 0,
  };
}

async function loadSnapshot(db: PrismaClient): Promise<PlayReviewSnapshot> {
  const [adminRow, caddyRow, reviewCaddies] = await Promise.all([
    db.user.findUnique({
      where: { username: PLAY_REVIEW_ADMIN_USERNAME },
      select: USER_SELECT,
    }),
    db.user.findUnique({
      where: { username: PLAY_REVIEW_CADDY_USERNAME },
      select: USER_SELECT,
    }),
    db.caddy.findMany({
      where: { memo: PLAY_REVIEW_CADDY_MEMO },
      select: {
        id: true,
        name: true,
        caddyType: true,
        team: true,
        teamOrder: true,
        employmentStatus: true,
        phoneNormalized: true,
        memo: true,
        user: { select: { id: true } },
      },
    }),
  ]);

  return {
    admin: adminRow ? mapUser(adminRow) : null,
    caddyUser: caddyRow ? mapUser(caddyRow) : null,
    reviewCaddies: reviewCaddies.map(
      (row): InspectedReviewCaddy => ({
        id: row.id,
        name: row.name,
        caddyType: String(row.caddyType),
        team: row.team,
        teamOrder: row.teamOrder,
        employmentStatus: String(row.employmentStatus),
        phoneNormalized: row.phoneNormalized,
        memo: row.memo,
        linkedUserId: row.user?.id ?? null,
      })
    ),
  };
}

function assertSafeUserWrite(username: string) {
  if (isForbiddenUserWrite(username) || !isPlayReviewUsername(username)) {
    throw new Error(`forbidden user write: ${username}`);
  }
}

async function applyCreate(
  db: PrismaClient,
  adminPassword: string,
  caddyPassword: string
): Promise<void> {
  const adminHash = await hashPassword(adminPassword);
  const caddyHash = await hashPassword(caddyPassword);
  await db.$transaction(async (tx) => {
    const caddy = await tx.caddy.create({
      data: {
        name: PLAY_REVIEW_CADDY_NAME,
        team: DRIVING_POOL_TEAM,
        teamOrder: 0,
        caddyType: "DRIVING",
        employmentStatus: "LEAVE",
        phoneNormalized: null,
        memo: PLAY_REVIEW_CADDY_MEMO,
        thirdBandSubgroup: null,
        extraFlags: [],
      },
      select: { id: true },
    });
    const admin = await tx.user.create({
      data: {
        username: PLAY_REVIEW_ADMIN_USERNAME,
        password: adminHash,
        role: "admin",
        kakaoUserId: null,
        caddyId: null,
        mustChangePassword: false,
        managedTeams: [],
      },
      select: { username: true },
    });
    assertSafeUserWrite(admin.username);
    const caddyUser = await tx.user.create({
      data: {
        username: PLAY_REVIEW_CADDY_USERNAME,
        password: caddyHash,
        role: "caddy",
        kakaoUserId: null,
        caddyId: caddy.id,
        mustChangePassword: false,
        managedTeams: [],
      },
      select: { username: true },
    });
    assertSafeUserWrite(caddyUser.username);
  });
}

async function applyDisable(
  db: PrismaClient,
  userIds: number[],
  caddyId: number | null
): Promise<void> {
  await db.$transaction(async (tx) => {
    if (userIds.length > 0) {
      await tx.devicePushToken.updateMany({
        where: { userId: { in: userIds }, enabled: true },
        data: { enabled: false },
      });
      await tx.pushSubscription.updateMany({
        where: { userId: { in: userIds }, enabled: true },
        data: { enabled: false },
      });
    }

    const admin = await tx.user.findUnique({
      where: { username: PLAY_REVIEW_ADMIN_USERNAME },
      select: { id: true, username: true },
    });
    if (admin) {
      assertSafeUserWrite(admin.username);
      await tx.user.update({
        where: { id: admin.id, username: PLAY_REVIEW_ADMIN_USERNAME },
        data: {
          password: null,
          sessionVersion: { increment: 1 },
        },
      });
    }

    const caddyUser = await tx.user.findUnique({
      where: { username: PLAY_REVIEW_CADDY_USERNAME },
      select: { id: true, username: true },
    });
    if (caddyUser) {
      assertSafeUserWrite(caddyUser.username);
      await tx.user.update({
        where: { id: caddyUser.id, username: PLAY_REVIEW_CADDY_USERNAME },
        data: {
          password: null,
          caddyId: null,
          sessionVersion: { increment: 1 },
        },
      });
    }

    if (caddyId != null) {
      const reviewCaddy = await tx.caddy.findFirst({
        where: { id: caddyId, memo: PLAY_REVIEW_CADDY_MEMO },
        select: { id: true },
      });
      if (!reviewCaddy) {
        throw new Error("review Caddy 식별 실패. 다른 명부는 수정하지 않습니다");
      }
      await tx.caddy.update({
        where: { id: reviewCaddy.id },
        data: { employmentStatus: "RETIRED" },
      });
    }
  });
}

async function main() {
  const args = parsePlayReviewArgs(process.argv.slice(2));
  const mode = args.disable ? "disable" : "create";
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL 이 없습니다.");
  }
  const isProduction = isProductionDatabaseUrl(url);
  const writeGate = canWritePlayReview({
    apply: args.apply,
    confirm: args.confirm,
    mode,
    isProduction,
    prodMaintenanceConfirm: process.env.PROD_MAINTENANCE_CONFIRM ?? null,
  });

  if (args.apply && writeGate.ok) {
    if (isProduction) {
      requireProdMaintenance(
        mode === "disable"
          ? PLAY_REVIEW_DISABLE_CONFIRM
          : PLAY_REVIEW_CREATE_CONFIRM
      );
    } else {
      assertLocalDatabaseUrl(url);
    }
  } else if (isProduction) {
    console.error("dry-run production inspect (write 0)");
  } else {
    assertLocalDatabaseUrl(url);
  }

  const prisma = new PrismaClient();
  try {
    const before = await loadSnapshot(prisma);
    const plan = args.disable
      ? planPlayReviewDisable(before)
      : planPlayReviewCreate(before);

    console.log(`mode=${mode}`);
    console.log(`apply=${args.apply && writeGate.ok}`);
    console.log(`plan=${plan.action} writes=${plan.writes}`);

    if (plan.action === "fail") {
      for (const error of plan.errors) console.error("FAIL:", error);
      process.exitCode = 3;
      console.log(formatPlayReviewReport(before));
      return;
    }

    if (plan.writes && writeGate.ok) {
      if (plan.action === "create") {
        const adminPassword = readPlayReviewPassword(
          process.env,
          PLAY_REVIEW_ADMIN_PASSWORD_ENV
        );
        const caddyPassword = readPlayReviewPassword(
          process.env,
          PLAY_REVIEW_CADDY_PASSWORD_ENV
        );
        await applyCreate(prisma, adminPassword, caddyPassword);
      } else if (plan.action === "disable") {
        await applyDisable(prisma, plan.userIds, plan.caddyId);
      }
    } else if (plan.writes && !writeGate.ok) {
      console.log(`write skipped: ${writeGate.reason}`);
    }

    const after = await loadSnapshot(prisma);
    console.log(formatPlayReviewReport(after));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "unknown_error";
  console.error(message);
  process.exit(1);
});
