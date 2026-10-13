/**
 * Create/update an admin User.
 *
 * Required: ADMIN_PASSWORD
 * Optional: ADMIN_USERNAME (default "admin")
 *
 * Local:
 *   ADMIN_PASSWORD=... DATABASE_URL=postgresql://caddy:caddy@localhost:5432/caddy_local \
 *     node scripts/create-admin.mjs
 *
 * Production (explicit maintenance only — do not run from tests):
 *   PROD_MAINTENANCE_CONFIRM=CREATE_ADMIN ADMIN_PASSWORD=... DATABASE_URL=... \
 *     node scripts/create-admin.mjs
 *
 * No source default password. Password/token values are never logged.
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcrypt";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const PRODUCTION_HOST_MARKERS = [
  "neon.tech",
  "vercel-storage",
  "amazonaws.com",
  "verthill",
];
const CREATE_ADMIN_CONFIRM = "CREATE_ADMIN";

function parseDatabaseUrl(url) {
  try {
    return new URL(url);
  } catch {
    throw new Error("DATABASE_URL parse 실패");
  }
}

function isProductionDatabaseUrl(url) {
  if (!url) return false;
  let parsed;
  try {
    parsed = parseDatabaseUrl(url);
  } catch {
    return false;
  }
  const host = parsed.hostname || "";
  if (PRODUCTION_HOST_MARKERS.some((m) => host.includes(m))) return true;
  const prod = process.env.PRODUCTION_DATABASE_URL;
  return Boolean(prod && prod === url);
}

function assertSafeDatabaseTarget(url) {
  if (!url) {
    throw new Error("DATABASE_URL 이 없습니다.");
  }
  const host = parseDatabaseUrl(url).hostname;
  if (isProductionDatabaseUrl(url)) {
    const expected = process.env.PROD_MAINTENANCE_CONFIRM;
    if (expected !== CREATE_ADMIN_CONFIRM) {
      throw new Error(
        `⛔ production maintenance 차단. 이 스크립트는 PROD_MAINTENANCE_CONFIRM=${CREATE_ADMIN_CONFIRM} 가 필요합니다. ALLOW_PROD_DB 같은 범용 스위치는 없습니다.`
      );
    }
    console.error("=== PRODUCTION MAINTENANCE ===");
    console.error("task:", CREATE_ADMIN_CONFIRM);
    console.error("host:", host);
    return;
  }
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(
      `⛔ Production/원격 DB write 차단: host=${host}. localhost 테스트 DB만 허용.`
    );
  }
}

async function main() {
  const username = String(process.env.ADMIN_USERNAME || "admin").trim();
  const plainPassword = process.env.ADMIN_PASSWORD;
  if (!plainPassword) {
    console.error(
      "ADMIN_PASSWORD 가 필요합니다. source default password는 없습니다."
    );
    process.exit(2);
  }
  if (!username) {
    console.error("ADMIN_USERNAME 이 비어 있습니다.");
    process.exit(2);
  }

  assertSafeDatabaseTarget(process.env.DATABASE_URL);

  const prisma = new PrismaClient();
  try {
    const hashed = await bcrypt.hash(plainPassword, 10);
    const user = await prisma.user.upsert({
      where: { username },
      update: { password: hashed, role: "admin" },
      create: { username, password: hashed, role: "admin" },
      select: { id: true, username: true, role: true },
    });
    console.log("관리자 계정 생성/갱신 완료:", user.username);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  const message = e instanceof Error ? e.message : "create-admin failed";
  console.error("create-admin error:", message);
  process.exit(1);
});
