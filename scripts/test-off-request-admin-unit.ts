/**
 * 관리자 OffRequest window/quota Phase 1.5.
 *
 *   npm run test:off-request-admin-unit
 *   ALLOW_DB_TEST=1 DATABASE_URL=postgresql://caddy:caddy@localhost:5432/caddy_local?schema=public \
 *     npm run test:off-request-admin-unit
 */
import { PrismaClient } from "@prisma/client";
import type { OffRequestActor } from "../src/lib/offRequestAuth";
import {
  canTransitionOffRequestWindow,
  isOccupiedOverLimit,
} from "../src/lib/offRequestDomain";
import { OffRequestServiceError, submitOffRequest } from "../src/lib/offRequestService";
import {
  closeOffRequestWindow,
  createOffRequestWindow,
  deleteOffRequestQuota,
  getOffRequestAdminMonth,
  getOffRequestCalendar,
  openOffRequestWindow,
  updateOffRequestWindow,
  upsertOffRequestQuota,
} from "../src/lib/offRequestWindowService";
import { offAssignmentDayRange } from "../src/lib/offRequestDomain";
import { formatKstDateTimeLocal } from "../src/lib/kstDate";
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

async function expectCode(fn: () => Promise<unknown>, code: string, msg: string) {
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

async function runLocalDbTests() {
  if (process.env.ALLOW_DB_TEST !== "1") {
    console.log("\n(skip local DB — set ALLOW_DB_TEST=1 + localhost DATABASE_URL to run)");
    return;
  }
  const url = process.env.DATABASE_URL || "";
  assertLocalDatabaseUrl(url);
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  const tag = `off-adm-${Date.now()}`;
  const year = 2110 + (Date.now() % 70);
  const month = `${year}-11`;
  const day = `${month}-12`;
  const admin = actorOf("admin", { username: `adm-${tag}`, userId: 1 });

  async function cleanup() {
    await prisma.offRequestAdjustment.deleteMany({
      where: { offRequest: { caddy: { name: { contains: tag } } } },
    });
    await prisma.offRequest.deleteMany({ where: { caddy: { name: { contains: tag } } } });
    await prisma.assignment.deleteMany({ where: { caddy: { name: { contains: tag } } } });
    await prisma.offRequestQuota.deleteMany({
      where: { window: { yearMonth: month } },
    });
    await prisma.offRequestWindow.deleteMany({ where: { yearMonth: month } });
    await prisma.user.deleteMany({ where: { username: { startsWith: `u-${tag}` } } });
    await prisma.caddy.deleteMany({ where: { name: { contains: tag } } });
  }

  try {
    await cleanup();

    section("window missing");
    const empty = await getOffRequestAdminMonth(prisma, admin, month);
    assert(empty.window === null, "admin month window null");
    assert(empty.days.length >= 28, "admin month has days");
    assert(empty.quotas.length === 0, "no quotas");

    section("create + duplicate");
    const created = await createOffRequestWindow(prisma, admin, {
      yearMonth: month,
      openAt: `${year}-10-01T00:00:00.000Z`,
      closeAt: `${year}-10-20T00:00:00.000Z`,
      defaultQuota: 5,
    });
    assert(created.status === "DRAFT", "create is DRAFT");
    assert(formatKstDateTimeLocal(created.openAt) === `${year}-10-01T09:00`, "create redisplay 09:00 KST");
    await expectCode(
      () =>
        createOffRequestWindow(prisma, admin, {
          yearMonth: `${year}-12`,
          openAt: `${year}-11-20T00:00:00.000Z`,
          closeAt: `${year}-11-20T00:00:00.000Z`,
        }),
      "invalid_schedule",
      "create openAt < closeAt"
    );
    await expectCode(
      () =>
        createOffRequestWindow(prisma, admin, {
          yearMonth: month,
          openAt: `${year}-10-02T00:00:00.000Z`,
          closeAt: `${year}-10-21T00:00:00.000Z`,
        }),
      "window_exists",
      "duplicate month"
    );

    section("DRAFT patch + quota override/delete");
    const patched = await updateOffRequestWindow(prisma, admin, created.id, {
      defaultQuota: 6,
      openAt: `${year}-10-20T00:00:00.000Z`,
      closeAt: `${year}-10-20T09:00:00.000Z`,
    });
    assert(patched.defaultQuota === 6, "DRAFT defaultQuota");
    assert(patched.openAt.toISOString() === `${year}-10-20T00:00:00.000Z`, "PATCH openAt UTC");
    assert(formatKstDateTimeLocal(patched.openAt) === `${year}-10-20T09:00`, "PATCH redisplay 09:00 KST");
    assert(formatKstDateTimeLocal(patched.closeAt) === `${year}-10-20T18:00`, "PATCH redisplay 18:00 KST");
    await expectCode(
      () =>
        updateOffRequestWindow(prisma, admin, created.id, {
          openAt: `${year}-10-20T10:00:00.000Z`,
          closeAt: `${year}-10-20T09:00:00.000Z`,
        }),
      "invalid_schedule",
      "PATCH openAt < closeAt"
    );
    await expectCode(
      () =>
        upsertOffRequestQuota(prisma, admin, {
          month,
          team: "7조",
          date: day,
          limit: 0,
        }),
      "invalid_quota",
      "limit 0 rejected"
    );
    await expectCode(
      () =>
        upsertOffRequestQuota(prisma, admin, {
          month,
          team: "7조",
          date: day,
          limit: 100,
        }),
      "invalid_quota",
      "limit 100 rejected"
    );
    await upsertOffRequestQuota(prisma, admin, {
      month,
      team: "7조",
      date: day,
      limit: 3,
    });
    await upsertOffRequestQuota(prisma, admin, {
      month,
      team: "8조",
      date: day,
      limit: 4,
    });
    const afterUpsert = await getOffRequestAdminMonth(prisma, admin, month);
    const dayRow = afterUpsert.days.find((d) => d.date === day);
    const t7 = dayRow?.teams.find((t) => t.team === "7조");
    const t8 = dayRow?.teams.find((t) => t.team === "8조");
    assert(t7?.limit === 3 && t7.override === true, "7조 override 3");
    assert(t8?.limit === 4 && t8.override === true, "8조 override 4");
    const del = await deleteOffRequestQuota(prisma, admin, {
      month,
      team: "8조",
      date: day,
    });
    assert(del.deleted === 1, "deleted 8조 override");
    const afterDel = await getOffRequestAdminMonth(prisma, admin, month);
    const t8b = afterDel.days.find((d) => d.date === day)?.teams.find((t) => t.team === "8조");
    assert(t8b?.limit === 6 && t8b.override === false, "8조 back to defaultQuota");

    const caddy = await prisma.caddy.create({
      data: { name: `C7-${tag}`, team: "7조", teamOrder: 91, employmentStatus: "ACTIVE" },
    });
    const user = await prisma.user.create({
      data: { username: `u-${tag}-7`, password: "x", role: "caddy", caddyId: caddy.id },
    });
    const caddyActor = actorOf("caddy", {
      username: user.username,
      userId: user.id,
      caddyId: caddy.id,
    });

    section("DRAFT→OPEN→ADJUSTING + reverse blocked");
    const opened = await openOffRequestWindow(prisma, admin, created.id);
    assert(opened.status === "OPEN", "DRAFT→OPEN");
    await expectCode(
      () => openOffRequestWindow(prisma, admin, created.id),
      "invalid_transition",
      "no re-open"
    );
    await expectCode(
      () =>
        updateOffRequestWindow(prisma, admin, created.id, { defaultQuota: 8 }),
      "invalid_transition",
      "OPEN blocks schedule/defaultQuota"
    );
    const req = await submitOffRequest(prisma, caddyActor, { date: day });
    assert(req.status === "REQUESTED", "OPEN submit");

    const offHolder = await prisma.caddy.create({
      data: { name: `OFF-${tag}`, team: "7조", teamOrder: 92, employmentStatus: "ACTIVE" },
    });
    const range = offAssignmentDayRange(day);
    await prisma.assignment.create({
      data: {
        caddyId: offHolder.id,
        type: "OFF",
        startDate: range.startDate,
        endDate: range.endDate,
        comment: tag,
      },
    });

    const summary = await getOffRequestAdminMonth(prisma, admin, month);
    const cell = summary.days.find((d) => d.date === day)?.teams.find((t) => t.team === "7조");
    assert(cell?.requestedCount === 1, "admin requested 1");
    assert(cell?.approvedCount === 1, "admin approved OFF 1");
    assert(cell?.occupied === 2, "admin occupied 2");
    assert(cell?.limit === 3, "admin limit override 3");
    assert(cell?.over === false, "1+1 / 3 not over");
    const dumped = JSON.stringify(summary);
    assert(!dumped.includes(caddy.name), "admin month hides caddy name");
    assert(!dumped.includes("phoneNormalized"), "no phone");

    const cal = await getOffRequestCalendar(prisma, caddyActor, month);
    const calDay = cal.days.find((d) => d.date === day);
    assert(calDay?.limit === 3, "caddy calendar same override");
    assert(calDay?.approvedCount === 1, "caddy calendar Assignment OFF");
    assert(calDay?.requestedCount === 1, "caddy calendar requested");
    assert(!JSON.stringify(cal).includes(offHolder.name), "caddy calendar hides other name");

    const openQuota = await upsertOffRequestQuota(prisma, admin, {
      month,
      team: "8조",
      date: day,
      limit: 5,
    });
    assert(openQuota.limit === 5, "OPEN still allows quota API (#209)");

    const closed = await closeOffRequestWindow(prisma, admin, created.id);
    assert(closed.status === "ADJUSTING", "OPEN→ADJUSTING");
    await expectCode(
      () => openOffRequestWindow(prisma, admin, created.id),
      "invalid_transition",
      "no ADJUSTING→OPEN"
    );
    await expectCode(
      () =>
        updateOffRequestWindow(prisma, admin, created.id, {
          defaultQuota: 9,
        }),
      "invalid_transition",
      "ADJUSTING blocks schedule/defaultQuota"
    );
    await expectCode(
      () =>
        upsertOffRequestQuota(prisma, admin, {
          month,
          team: "7조",
          date: day,
          limit: 2,
        }),
      "window_adjusting",
      "ADJUSTING blocks quota put"
    );
    await expectCode(
      () =>
        deleteOffRequestQuota(prisma, admin, {
          month,
          team: "7조",
          date: day,
        }),
      "window_adjusting",
      "ADJUSTING blocks quota delete"
    );

    await cleanup();
    assert(true, "local cleanup done");
  } finally {
    await prisma.$disconnect();
  }
}

async function main() {
  section("transitions + admin guards (no DB)");
  {
    assert(canTransitionOffRequestWindow("DRAFT", "OPEN"), "DRAFT→OPEN");
    assert(canTransitionOffRequestWindow("OPEN", "ADJUSTING"), "OPEN→ADJUSTING");
    assert(!canTransitionOffRequestWindow("OPEN", "DRAFT"), "no OPEN→DRAFT");
    assert(!canTransitionOffRequestWindow("ADJUSTING", "OPEN"), "no ADJUSTING→OPEN");
    assert(!canTransitionOffRequestWindow("DRAFT", "FINALIZED"), "no DRAFT→FINALIZED");
    assert(
      isOccupiedOverLimit({ approvedCount: 2, requestedCount: 4, limit: 5 }),
      "2 OFF + 4 REQUESTED / 5 is over"
    );
    assert(
      !isOccupiedOverLimit({ approvedCount: 2, requestedCount: 3, limit: 5 }),
      "2+3 / 5 is not over"
    );
    const caddy = actorOf("caddy", { caddyId: 1 });
    await expectCode(
      () =>
        createOffRequestWindow({} as never, caddy, {
          yearMonth: "2099-11",
          openAt: "2099-10-01T00:00:00.000Z",
          closeAt: "2099-10-20T00:00:00.000Z",
        }),
      "forbidden",
      "non-admin cannot create"
    );
    await expectCode(
      () => getOffRequestAdminMonth({} as never, caddy, "2099-11"),
      "forbidden",
      "non-admin cannot read admin month"
    );
    await expectCode(
      () =>
        deleteOffRequestQuota({} as never, caddy, {
          month: "2099-11",
          team: "7조",
          date: "2099-11-12",
        }),
      "forbidden",
      "non-admin cannot delete quota"
    );
  }

  await runLocalDbTests();
  console.log(`\nDONE: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
