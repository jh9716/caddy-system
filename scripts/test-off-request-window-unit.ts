/**
 * OffRequest monthly window Phase 1.
 * 순수 가드 + 로컬 DB.
 *
 *   npm run test:off-request-window-unit
 *   ALLOW_DB_TEST=1 DATABASE_URL=postgresql://caddy:caddy@localhost:5432/caddy_local?schema=public \
 *     npm run test:off-request-window-unit
 */
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import type { OffRequestActor } from "../src/lib/offRequestAuth";
import { OffRequestServiceError, submitOffRequest, cancelOwnOffRequest } from "../src/lib/offRequestService";
import {
  closeOffRequestWindow,
  createOffRequestWindow,
  getOffRequestCalendar,
  getOffRequestWindow,
  openOffRequestWindow,
  rescheduleOwnOffRequest,
  serializeOffRequestWindow,
  updateOffRequestWindow,
  upsertOffRequestQuota,
} from "../src/lib/offRequestWindowService";
import { ymdDaysInYearMonth } from "../src/lib/offRequestDomain";
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

async function expectCode(
  fn: () => Promise<unknown>,
  code: string,
  msg: string
) {
  try {
    await fn();
    assert(false, msg);
  } catch (e) {
    assert(e instanceof OffRequestServiceError && e.code === code, msg);
  }
}

function actorOf(
  role: OffRequestActor["role"],
  extra: Partial<OffRequestActor> = {}
): OffRequestActor {
  return {
    role,
    username: extra.username ?? role,
    userId: extra.userId ?? null,
    caddyId: extra.caddyId ?? null,
    managedTeams: extra.managedTeams ?? [],
  };
}

section("migration additive audit (files)");
{
  const sql = fs.readFileSync(
    path.resolve("prisma/migrations/20261001120000_off_request_window/migration.sql"),
    "utf8"
  );
  assert(sql.includes("UNSELECTED"), "adds UNSELECTED");
  assert(sql.includes("OffRequestWindow"), "adds window");
  assert(sql.includes("OffRequestQuota"), "adds quota");
  assert(sql.includes("OffRequestAdjustment"), "adds adjustment");
  assert(sql.includes("OffRequestTeamFinalization"), "adds team finalization");
  assert(!/DROP TABLE/i.test(sql), "no DROP TABLE");
  assert(!/DROP TYPE/i.test(sql), "no DROP TYPE");
  assert(!/DROP INDEX/i.test(sql), "no DROP INDEX");
  assert(!/ALTER TABLE "Assignment"/i.test(sql), "no Assignment ALTER");
  assert(!/CREATE TABLE "Assignment"/i.test(sql), "no Assignment CREATE");
  assert(!/ALTER TABLE "DailyBoard/i.test(sql), "no DailyBoard ALTER");
  assert(!/CREATE TABLE "DailyBoard/i.test(sql), "no DailyBoard CREATE");
}

async function main() {
section("serialize + admin guard (no DB)");
{
  const draft = {
    id: 1,
    yearMonth: "2026-10",
    status: "DRAFT" as const,
    openAt: new Date("2026-09-01T00:00:00Z"),
    closeAt: new Date("2026-09-20T00:00:00Z"),
    adjustingAt: null,
    finalizedAt: null,
    finalizedByUserId: null,
    defaultQuota: 5,
    createdAt: new Date("2026-08-01T00:00:00Z"),
    updatedAt: new Date("2026-08-01T00:00:00Z"),
  };
  const ser = serializeOffRequestWindow(draft);
  assert(ser.status === "DRAFT" && ser.yearMonth === "2026-10", "serialize window");
  await expectCode(
    () =>
      createOffRequestWindow({} as any, actorOf("caddy", { caddyId: 1 }), {
        yearMonth: "2026-10",
        openAt: "2026-09-01T00:00:00.000Z",
        closeAt: "2026-09-20T00:00:00.000Z",
      }),
    "forbidden",
    "caddy cannot create window"
  );
}

async function runLocalDbTests() {
  if (process.env.ALLOW_DB_TEST !== "1") {
    console.log("\n(skip local DB — set ALLOW_DB_TEST=1 + localhost DATABASE_URL to run)");
    return;
  }
  const url = process.env.DATABASE_URL || "";
  assertLocalDatabaseUrl(url);
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  const tag = `off-win-${Date.now()}`;
  const year = 2100 + (Date.now() % 80);
  const ym = (m: number) => `${year}-${String(m).padStart(2, "0")}`;
  const team = `TW-${tag}`;

  const admin = actorOf("admin", { username: `adm-${tag}`, userId: 1 });

  async function cleanup() {
    await prisma.offRequestAdjustment.deleteMany({
      where: { offRequest: { caddy: { team } } },
    });
    await prisma.offRequest.deleteMany({ where: { caddy: { team } } });
    await prisma.offRequestQuota.deleteMany({
      where: { window: { yearMonth: { startsWith: `${year}-` } } },
    });
    await prisma.offRequestTeamFinalization.deleteMany({
      where: { window: { yearMonth: { startsWith: `${year}-` } } },
    });
    await prisma.offRequestWindow.deleteMany({
      where: { yearMonth: { startsWith: `${year}-` } },
    });
    await prisma.user.deleteMany({
      where: { username: { startsWith: `u-${tag}` } },
    });
    await prisma.caddy.deleteMany({ where: { team } });
  }

  try {
    await cleanup();

    const caddy = await prisma.caddy.create({
      data: { name: `C1-${tag}`, team, teamOrder: 1, employmentStatus: "ACTIVE" },
    });
    const caddy2 = await prisma.caddy.create({
      data: { name: `C2-SECRET-${tag}`, team, teamOrder: 2, employmentStatus: "ACTIVE" },
    });
    const retiredCaddy = await prisma.caddy.create({
      data: { name: `RET-${tag}`, team, teamOrder: 3, employmentStatus: "RETIRED" },
    });
    const user1 = await prisma.user.create({
      data: {
        username: `u-${tag}-1`,
        password: "x",
        role: "caddy",
        caddyId: caddy.id,
      },
    });
    const user2 = await prisma.user.create({
      data: {
        username: `u-${tag}-2`,
        password: "x",
        role: "caddy",
        caddyId: caddy2.id,
      },
    });
    const caddyActor = actorOf("caddy", {
      username: user1.username,
      userId: user1.id,
      caddyId: caddy.id,
    });
    const caddy2Actor = actorOf("caddy", {
      username: user2.username,
      userId: user2.id,
      caddyId: caddy2.id,
    });
    const retiredActor = actorOf("caddy", {
      username: `u-${tag}-r`,
      userId: user1.id,
      caddyId: retiredCaddy.id,
    });

    section("14 window missing");
    await expectCode(
      () => submitOffRequest(prisma, caddyActor, { date: `${ym(1)}-15` }),
      "window_not_found",
      "no window cannot submit"
    );

    section("19 DRAFT create / 1 DRAFT submit blocked / patch / open");
    const created = await createOffRequestWindow(prisma, admin, {
      yearMonth: ym(1),
      openAt: `${year}-01-01T00:00:00.000Z`,
      closeAt: `${year}-01-20T00:00:00.000Z`,
      defaultQuota: 5,
    });
    assert(created.status === "DRAFT", "created DRAFT");
    const fetched = await getOffRequestWindow(prisma, ym(1));
    assert(fetched?.id === created.id, "GET window by month");

    await expectCode(
      () => submitOffRequest(prisma, caddyActor, { date: `${ym(1)}-15` }),
      "window_not_open",
      "DRAFT blocks submit"
    );

    const patched = await updateOffRequestWindow(prisma, admin, created.id, {
      defaultQuota: 6,
      openAt: `${year}-01-02T00:00:00.000Z`,
      closeAt: `${year}-01-21T00:00:00.000Z`,
    });
    assert(patched.defaultQuota === 6, "DRAFT patch defaultQuota");

    const opened = await openOffRequestWindow(prisma, admin, created.id);
    assert(opened.status === "OPEN", "DRAFT → OPEN");

    await expectCode(
      () =>
        updateOffRequestWindow(prisma, admin, created.id, { defaultQuota: 4 }),
      "invalid_transition",
      "cannot patch after OPEN"
    );
    await expectCode(
      () => openOffRequestWindow(prisma, admin, created.id),
      "invalid_transition",
      "cannot re-open OPEN"
    );

    section("2 OPEN submit / 9 over-quota allowed / 10 duplicate / 11 outside / 12 past / 13 retired");
    const day15 = `${ym(1)}-15`;
    const day16 = `${ym(1)}-16`;
    const submitted = await submitOffRequest(prisma, caddyActor, { date: day15 });
    assert(submitted.status === "REQUESTED", "OPEN submit");

    await expectCode(
      () => submitOffRequest(prisma, caddyActor, { date: day15 }),
      "duplicate_active",
      "active duplicate blocked"
    );

    await expectCode(
      () => submitOffRequest(prisma, caddyActor, { date: `${ym(2)}-15` }),
      "window_not_found",
      "outside month without window"
    );
    await expectCode(
      () => submitOffRequest(prisma, caddyActor, { date: `${year - 1}-12-15` }),
      "window_not_found",
      "other month no window"
    );

    await expectCode(
      () =>
        submitOffRequest(prisma, caddyActor, {
          date: day16,
          now: new Date(`${year + 1}-01-01T00:00:00+09:00`),
        }),
      "past_date",
      "past date blocked"
    );

    await expectCode(
      () => submitOffRequest(prisma, retiredActor, { date: day16 }),
      "retired",
      "RETIRED blocked"
    );

    const extras = [];
    for (let i = 0; i < 5; i++) {
      const extra = await prisma.caddy.create({
        data: {
          name: `EX${i}-${tag}`,
          team,
          teamOrder: 10 + i,
          employmentStatus: "ACTIVE",
        },
      });
      extras.push(extra);
      const extraUser = await prisma.user.create({
        data: {
          username: `u-${tag}-e${i}`,
          password: "x",
          role: "caddy",
          caddyId: extra.id,
        },
      });
      const row = await submitOffRequest(
        prisma,
        actorOf("caddy", {
          username: extraUser.username,
          userId: extraUser.id,
          caddyId: extra.id,
        }),
        { date: day15 }
      );
      assert(row.status === "REQUESTED", `over-quota submit ${i + 2}/6 allowed`);
    }

    section("15-17 calendar counts / override / no names");
    const cal1 = await getOffRequestCalendar(prisma, caddyActor, ym(1));
    const cell15 = cal1.days.find((d) => d.date === day15);
    assert(cal1.days.length === ymdDaysInYearMonth(ym(1)).length, "calendar days");
    assert(cell15?.requestedCount === 6, "requestedCount 6");
    assert(cell15?.limit === 6, "limit uses window defaultQuota 6");
    assert(cell15?.over === false, "6/6 is not over");
    assert(cell15?.mine?.id === submitted.id, "mine is self");
    const dumped = JSON.stringify(cal1);
    assert(!dumped.includes(caddy2.name), "calendar hides other caddy name");
    assert(!dumped.includes("C2-SECRET"), "calendar payload has no other name");

    await upsertOffRequestQuota(prisma, admin, {
      month: ym(1),
      team,
      date: day15,
      limit: 3,
    });
    const cal2 = await getOffRequestCalendar(prisma, caddyActor, ym(1));
    const cell15b = cal2.days.find((d) => d.date === day15);
    assert(cell15b?.limit === 3, "quota override");
    assert(cell15b?.over === true, "6/3 is over");

    section("3 cancel / 4-6 reschedule + adjustment + dest duplicate");
    const other = await submitOffRequest(prisma, caddy2Actor, { date: day16 });
    const parked = await submitOffRequest(prisma, caddyActor, {
      date: `${ym(1)}-18`,
    });
    assert(parked.status === "REQUESTED", "second own date allowed");
    await expectCode(
      () =>
        rescheduleOwnOffRequest(prisma, caddyActor, submitted.id, {
          toDate: `${ym(1)}-18`,
        }),
      "duplicate_active",
      "reschedule dest duplicate"
    );
    await expectCode(
      () =>
        rescheduleOwnOffRequest(prisma, caddyActor, submitted.id, {
          toDate: `${ym(2)}-15`,
        }),
      "outside_window",
      "reschedule outside month blocked"
    );
    const moved = await rescheduleOwnOffRequest(prisma, caddyActor, submitted.id, {
      toDate: `${ym(1)}-20`,
      reason: "조율",
    });
    assert(moved.offRequest.date.toISOString().startsWith(`${ym(1)}-20`), "moved date");
    const adj = await prisma.offRequestAdjustment.findUnique({
      where: { id: moved.adjustmentId },
    });
    assert(adj?.adjustedByUserId === user1.id, "adjustment by user");
    assert(adj?.reason === "조율", "adjustment reason");
    assert(adj?.offRequestId === submitted.id, "adjustment links request");

    const cancelled = await cancelOwnOffRequest(prisma, caddy2Actor, other.id);
    assert(cancelled.status === "CANCELLED", "OPEN cancel");

    section("20-21 close + reverse blocked / 7 ADJUSTING write / 8 FINALIZED write");
    const closed = await closeOffRequestWindow(prisma, admin, created.id);
    assert(closed.status === "ADJUSTING", "OPEN → ADJUSTING");
    assert(closed.adjustingAt != null, "adjustingAt set");

    await expectCode(
      () => openOffRequestWindow(prisma, admin, created.id),
      "invalid_transition",
      "no ADJUSTING → OPEN"
    );
    await expectCode(
      () =>
        submitOffRequest(prisma, caddy2Actor, { date: `${ym(1)}-21` }),
      "window_not_open",
      "ADJUSTING blocks submit"
    );
    await expectCode(
      () => cancelOwnOffRequest(prisma, caddyActor, submitted.id),
      "window_not_open",
      "ADJUSTING blocks cancel"
    );
    await expectCode(
      () =>
        rescheduleOwnOffRequest(prisma, caddyActor, submitted.id, {
          toDate: `${ym(1)}-22`,
        }),
      "window_not_open",
      "ADJUSTING blocks reschedule"
    );

    await prisma.offRequestWindow.update({
      where: { id: created.id },
      data: { status: "FINALIZED", finalizedAt: new Date() },
    });
    await expectCode(
      () =>
        submitOffRequest(prisma, caddy2Actor, { date: `${ym(1)}-23` }),
      "window_not_open",
      "FINALIZED blocks submit"
    );
    await expectCode(
      () =>
        upsertOffRequestQuota(prisma, admin, {
          month: ym(1),
          team,
          date: `${ym(1)}-23`,
          limit: 2,
        }),
      "window_finalized",
      "FINALIZED blocks quota"
    );

    section("18 KST boundary service");
    const oct = await createOffRequestWindow(prisma, admin, {
      yearMonth: ym(10),
      openAt: `${year}-09-01T00:00:00.000Z`,
      closeAt: `${year}-10-20T00:00:00.000Z`,
    });
    await openOffRequestWindow(prisma, admin, oct.id);
    const justAfterMidnight = new Date(`${year}-10-01T00:30:00+09:00`);
    await expectCode(
      () =>
        submitOffRequest(prisma, caddy2Actor, {
          date: `${year}-09-30`,
          now: justAfterMidnight,
        }),
      "window_not_found",
      "KST yesterday is outside October window"
    );
    const kstOk = await submitOffRequest(prisma, caddy2Actor, {
      date: `${year}-10-01`,
      now: justAfterMidnight,
    });
    assert(kstOk.status === "REQUESTED", "KST Oct 1 00:30 allows Oct 1");

    await cleanup();
    assert(true, "local cleanup done");
  } finally {
    await prisma.$disconnect();
  }
}

await runLocalDbTests();

console.log(`\nDONE: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
