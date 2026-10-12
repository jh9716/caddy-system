/**
 * Seed only an isolated preview296 database.
 * Rejects the production Neon host. Never copies production rows.
 *
 *   DATABASE_URL=... PREVIEW296_ADMIN_PASSWORD=... PREVIEW296_CADDY_PASSWORD=... \
 *     npx tsx scripts/preview296/seed-isolated-db.ts
 */
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../../src/lib/userPassword";
import {
  assertIsolatedPreview296DatabaseUrl,
  isForbiddenProductionDatabaseHost,
} from "../../src/lib/preview296Isolation";

const ADMIN_USERNAME = "preview296_admin";
const CADDY_USERNAME = "preview296_caddy";
const CADDY_NAME = "미리보기296 캐디";

function readPassword(name: string): string {
  const value = String(process.env[name] || "").trim();
  if (value.length < 8) {
    throw new Error(`${name} 는 8자 이상이어야 합니다.`);
  }
  return value;
}

async function main() {
  const url = assertIsolatedPreview296DatabaseUrl(process.env.DATABASE_URL);
  if (isForbiddenProductionDatabaseHost(process.env.PRODUCTION_DATABASE_URL || "")) {
    // Presence of the prod URL in the environment is fine; using it is not.
  }
  const adminPassword = readPassword("PREVIEW296_ADMIN_PASSWORD");
  const caddyPassword = readPassword("PREVIEW296_CADDY_PASSWORD");
  const host = new URL(url).hostname;
  console.log(`[preview296 seed] host=${host} db=${new URL(url).pathname}`);

  const prisma = new PrismaClient({ datasources: { db: { url } } });
  try {
    const adminHash = await hashPassword(adminPassword);
    const caddyHash = await hashPassword(caddyPassword);

    const admin = await prisma.user.upsert({
      where: { username: ADMIN_USERNAME },
      update: {
        password: adminHash,
        role: "admin",
        mustChangePassword: false,
        kakaoUserId: null,
        caddyId: null,
      },
      create: {
        username: ADMIN_USERNAME,
        password: adminHash,
        role: "admin",
        mustChangePassword: false,
      },
    });

    let caddyRow = await prisma.caddy.findFirst({ where: { name: CADDY_NAME, team: "1조" } });
    if (!caddyRow) {
      caddyRow = await prisma.caddy.create({
        data: {
          name: CADDY_NAME,
          team: "1조",
          employmentStatus: "ACTIVE",
          caddyType: "HOUSE",
        },
      });
    }

    const caddyUser = await prisma.user.upsert({
      where: { username: CADDY_USERNAME },
      update: {
        password: caddyHash,
        role: "caddy",
        mustChangePassword: false,
        kakaoUserId: null,
        caddyId: caddyRow.id,
      },
      create: {
        username: CADDY_USERNAME,
        password: caddyHash,
        role: "caddy",
        mustChangePassword: false,
        caddyId: caddyRow.id,
      },
    });

    console.log(
      JSON.stringify({
        ok: true,
        host,
        adminUserId: admin.id,
        caddyUserId: caddyUser.id,
        caddyId: caddyRow.id,
        adminUsername: ADMIN_USERNAME,
        caddyUsername: CADDY_USERNAME,
      })
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error("[preview296 seed]", error instanceof Error ? error.message : error);
  process.exit(1);
});
