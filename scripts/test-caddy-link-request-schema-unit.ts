/**
 * CaddyLinkRequest schema/migration 정적 + local DB 제약 검증 (API/UI 없음)
 * 실행: npx tsx scripts/test-caddy-link-request-schema-unit.ts
 *
 * Production write 금지. DATABASE_URL 이 localhost 가 아니면 제약 INSERT 테스트는 skip.
 */
import fs from "node:fs";
import path from "node:path";
import { PrismaClient, Prisma } from "@prisma/client";

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

function isLocalDatabaseUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url.replace(/^postgres(ql)?:/i, "http:"));
    return (
      u.hostname === "localhost" ||
      u.hostname === "127.0.0.1" ||
      u.hostname === "::1"
    );
  } catch {
    return false;
  }
}

section("migration SQL static");
{
  const sqlPath = path.resolve(
    "prisma/migrations/20260812080000_caddy_link_request/migration.sql"
  );
  const sql = fs.readFileSync(sqlPath, "utf8");
  assert(fs.existsSync(sqlPath), "migration file exists");
  assert(sql.includes('CREATE TYPE "CaddyLinkRequestStatus"'), "creates enum");
  assert(sql.includes('CREATE TABLE IF NOT EXISTS "CaddyLinkRequest"'), "creates table");
  assert(sql.includes('"candidateCaddyIds" INTEGER[]'), "Int[] column");
  assert(sql.includes("ON DELETE RESTRICT"), "userId Restrict");
  assert(sql.includes("ON DELETE SET NULL"), "selectedCaddyId SetNull");
  assert(
    sql.includes('CREATE UNIQUE INDEX IF NOT EXISTS "CaddyLinkRequest_userId_pending_key"'),
    "partial unique name fixed"
  );
  assert(sql.includes(`WHERE "status" = 'PENDING'`), "partial unique PENDING only");
  assert(!/UPDATE\s+"User"/i.test(sql), "no User UPDATE");
  assert(!/UPDATE\s+"Caddy"/i.test(sql), "no Caddy UPDATE");
  assert(!/DELETE\s+FROM/i.test(sql), "no DELETE FROM");
  assert(!/ALTER TABLE "User"/i.test(sql), "no User ALTER");
  assert(!/ALTER TABLE "Caddy"/i.test(sql), "no Caddy ALTER");
  assert(!/ALTER TABLE "OffRequest"/i.test(sql), "no OffRequest ALTER");
  assert(
    !sql.includes("decidedByUserId_fkey") &&
      sql.includes("decidedByUserId: FK 없음"),
    "no decidedByUserId FK"
  );
}

section("schema.prisma comments / relations");
{
  const schema = fs.readFileSync("prisma/schema.prisma", "utf8");
  assert(schema.includes("enum CaddyLinkRequestStatus"), "enum in schema");
  assert(schema.includes("model CaddyLinkRequest"), "model in schema");
  assert(schema.includes("CaddyLinkRequest_userId_pending_key"), "partial unique documented");
  assert(schema.includes("onDelete: Restrict"), "user Restrict");
  assert(schema.includes("onDelete: SetNull"), "selected SetNull");
  assert(schema.includes("caddyLinkRequests CaddyLinkRequest[]"), "User reverse");
  assert(
    schema.includes('linkRequestSelections CaddyLinkRequest[]'),
    "Caddy reverse"
  );
  assert(
    !/decidedByUser\s+User\?/.test(schema),
    "decidedByUserId has no User relation/FK"
  );
}

async function runDbTests() {
  const url = process.env.DATABASE_URL;
  if (!isLocalDatabaseUrl(url)) {
    console.log("\n(skip DB constraint tests — local DATABASE_URL required)");
    return;
  }

  section("local DB constraints");
  const prisma = new PrismaClient();
  let userId: number | null = null;
  let caddyId: number | null = null;

  try {
    const user = await prisma.user.create({
      data: {
        username: `clr_schema_test_${Date.now()}`,
        password: null,
        role: "caddy",
        kakaoUserId: `test-clr-${Date.now()}`,
      },
    });
    userId = user.id;

    const caddy = await prisma.caddy.create({
      data: {
        name: `CLR테스트${Date.now() % 100000}`,
        team: "1조",
        teamOrder: 9999,
      },
    });
    caddyId = caddy.id;

    const pending = await prisma.caddyLinkRequest.create({
      data: {
        userId: user.id,
        submittedName: "홍길동",
        phoneNormalized: "01012345678",
        candidateCaddyIds: [caddy.id, caddy.id + 1],
        status: "PENDING",
      },
    });
    assert(pending.id > 0, "create PENDING");
    assert(
      Array.isArray(pending.candidateCaddyIds) &&
        pending.candidateCaddyIds[0] === caddy.id,
      "candidateCaddyIds round-trip"
    );

    let dupBlocked = false;
    try {
      await prisma.caddyLinkRequest.create({
        data: {
          userId: user.id,
          submittedName: "홍길동",
          phoneNormalized: "01099998888",
          candidateCaddyIds: [],
          status: "PENDING",
        },
      });
    } catch (e) {
      dupBlocked =
        e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
    }
    assert(dupBlocked, "second PENDING same user → P2002");

    await prisma.caddyLinkRequest.update({
      where: { id: pending.id },
      data: {
        status: "REJECTED",
        decidedAt: new Date(),
        decisionNote: "schema-test",
      },
    });

    const again = await prisma.caddyLinkRequest.create({
      data: {
        userId: user.id,
        submittedName: "홍길동",
        phoneNormalized: "01011112222",
        candidateCaddyIds: [caddy.id],
        status: "PENDING",
      },
    });
    assert(again.id !== pending.id, "after REJECTED new PENDING allowed");

    await prisma.caddyLinkRequest.update({
      where: { id: again.id },
      data: { status: "CANCELLED" },
    });
    const afterCancel = await prisma.caddyLinkRequest.create({
      data: {
        userId: user.id,
        submittedName: "홍길동",
        phoneNormalized: "01033334444",
        candidateCaddyIds: [caddy.id],
        status: "PENDING",
      },
    });
    assert(afterCancel.id > 0, "after CANCELLED new PENDING allowed");

    await prisma.caddyLinkRequest.update({
      where: { id: afterCancel.id },
      data: {
        status: "APPROVED",
        selectedCaddyId: caddy.id,
        decidedAt: new Date(),
      },
    });
    const afterApproved = await prisma.caddyLinkRequest.create({
      data: {
        userId: user.id,
        submittedName: "홍길동",
        phoneNormalized: "01055556666",
        candidateCaddyIds: [caddy.id],
        status: "PENDING",
      },
    });
    assert(afterApproved.id > 0, "after APPROVED new PENDING allowed");

    const idx = await prisma.$queryRawUnsafe<Array<{ indexname: string }>>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname = 'CaddyLinkRequest_userId_pending_key'`
    );
    assert(idx.length === 1, "partial unique index present in DB");
  } finally {
    // cleanup test rows only (local)
    if (userId != null) {
      await prisma.caddyLinkRequest.deleteMany({ where: { userId } });
      await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    }
    if (caddyId != null) {
      await prisma.caddy.delete({ where: { id: caddyId } }).catch(() => undefined);
    }
    await prisma.$disconnect();
  }
}

runDbTests()
  .then(() => {
    console.log(`\nDONE: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
