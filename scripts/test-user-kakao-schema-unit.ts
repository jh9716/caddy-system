/**
 * User kakaoUserId / password nullable — 단위 + 로컬 DB 검증
 *
 * ⛔ Production write 금지.
 *
 *   npx tsx scripts/test-user-kakao-schema-unit.ts
 *
 * 로컬 DB:
 *   ALLOW_DB_TEST=1 DATABASE_URL=postgresql://caddy:caddy@localhost:5432/caddy_local?schema=public \
 *     npx tsx scripts/test-user-kakao-schema-unit.ts
 */
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";
import {
  hasPasswordHash,
  verifyUserPassword,
} from "../src/lib/userPassword";
import { assertLocalDatabaseUrl } from "./assertLocalDatabaseUrl";

let passed = 0;
let failed = 0;

function assert(cond: unknown, msg: string) {
  if (cond) {
    passed++;
    console.log("  ✓", msg);
  } else {
    failed++;
    console.error("  ✗", msg);
  }
}

function section(title: string) {
  console.log("\n==", title, "==");
}

async function main() {
  section("hasPasswordHash / verifyUserPassword (no DB)");
  assert(hasPasswordHash("abc") === true, "non-empty hash ok");
  assert(hasPasswordHash(null) === false, "null not hash");
  assert(hasPasswordHash(undefined) === false, "undefined not hash");
  assert(hasPasswordHash("") === false, "empty not hash");

  const hash = await bcrypt.hash("secret-ok", 10);
  assert(
    (await verifyUserPassword("secret-ok", hash)) === true,
    "password User login success"
  );
  assert(
    (await verifyUserPassword("wrong", hash)) === false,
    "wrong password fails"
  );
  assert(
    (await verifyUserPassword("anything", null)) === false,
    "password=null safely fails (no throw)"
  );
  assert(
    (await verifyUserPassword("anything", undefined)) === false,
    "password=undefined safely fails"
  );
  assert(
    (await verifyUserPassword("anything", "")) === false,
    "password='' safely fails"
  );

  if (process.env.ALLOW_DB_TEST !== "1") {
    console.log("\n(skip local DB — set ALLOW_DB_TEST=1 + localhost DATABASE_URL)");
    console.log(`\nDONE: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
    return;
  }

  const url = process.env.DATABASE_URL || "";
  assertLocalDatabaseUrl(url);
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  const tag = `kakao-schema-${Date.now()}`;

  try {
    section("local DB: kakaoUserId unique + password null + no backfill");

    const col = await prisma.$queryRawUnsafe<
      Array<{ column_name: string; is_nullable: string; data_type: string }>
    >(
      `SELECT column_name, is_nullable, data_type
       FROM information_schema.columns
       WHERE table_schema='public' AND table_name='User'
         AND column_name IN ('kakaoUserId','password')
       ORDER BY column_name`
    );
    const kakaoCol = col.find((c) => c.column_name === "kakaoUserId");
    const pwCol = col.find((c) => c.column_name === "password");
    assert(!!kakaoCol, "kakaoUserId column exists");
    assert(pwCol?.is_nullable === "YES", "password is nullable");

    const oauth = await prisma.user.create({
      data: {
        username: `oauth-${tag}`,
        password: null,
        role: "caddy",
        kakaoUserId: "1234567890",
        managedTeams: [],
      },
    });
    assert(oauth.password === null, "OAuth user password null");
    assert(oauth.kakaoUserId === "1234567890", "kakaoUserId stored as string");
    assert(
      (await verifyUserPassword("x", oauth.password)) === false,
      "OAuth user ID/PW verify fails safely"
    );

    let uniqueHit = false;
    try {
      await prisma.user.create({
        data: {
          username: `oauth2-${tag}`,
          password: null,
          role: "caddy",
          kakaoUserId: "1234567890",
        },
      });
    } catch (e: any) {
      uniqueHit = e?.code === "P2002";
    }
    assert(uniqueHit, "kakaoUserId unique enforced");

    // 기존 형태 password User 로그인 검증용
    const pwUser = await prisma.user.create({
      data: {
        username: `pw-${tag}`,
        password: hash,
        role: "admin",
      },
    });
    assert(
      (await verifyUserPassword("secret-ok", pwUser.password)) === true,
      "password User still verifies"
    );
    assert(pwUser.kakaoUserId === null, "no auto backfill kakaoUserId");

    // partial unique OffRequest index untouched
    const idx = await prisma.$queryRawUnsafe<Array<{ indexname: string }>>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname='public' AND indexname='OffRequest_caddyId_date_active_key'`
    );
    assert(idx.length === 1, "OffRequest_caddyId_date_active_key still present");

    await prisma.user.deleteMany({
      where: { username: { in: [oauth.username, `oauth2-${tag}`, pwUser.username] } },
    });
    assert(true, "local cleanup");
  } finally {
    await prisma.$disconnect();
  }

  console.log(`\nDONE: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
