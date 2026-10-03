/**
 * OffRequest Phase 2 — 팀장 조정 / 팀 확정 / 관리자 FINALIZED.
 *
 *   npm run test:off-request-phase2-unit
 *   ALLOW_DB_TEST=1 DATABASE_URL=postgresql://caddy:caddy@localhost:5432/caddy_local?schema=public \
 *     npm run test:off-request-phase2-unit
 */
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import type { OffRequestActor } from "../src/lib/offRequestAuth";
import {
  canAdjustOffRequestWindow,
  canFinalizeOffRequestWindow,
  normalizeOffDateInput,
  offAssignmentDayRange,
} from "../src/lib/offRequestDomain";
import { OffRequestServiceError } from "../src/lib/offRequestService";
import {
  finalizeOffRequestWindow,
  finalizeTeamOffRequests,
  getOffRequestAdminProgress,
  getOffRequestLeaderTeamMonth,
  rescheduleTeamOffRequest,
} from "../src/lib/offRequestPhase2Service";
import {
  closeOffRequestWindow,
  createOffRequestWindow,
  openOffRequestWindow,
  upsertOffRequestQuota,
} from "../src/lib/offRequestWindowService";
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

function read(rel: string) {
  return fs.readFileSync(path.resolve(rel), "utf8");
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

async function expectCode(fn: () => Promise<unknown>, code: string, msg: string) {
  try {
    await fn();
    assert(false, msg);
  } catch (e) {
    assert(e instanceof OffRequestServiceError && e.code === code, msg);
  }
}

section("pure + wiring");
{
  assert(canAdjustOffRequestWindow("ADJUSTING"), "adjust ADJUSTING");
  assert(!canAdjustOffRequestWindow("OPEN"), "no adjust OPEN");
  assert(canFinalizeOffRequestWindow("ADJUSTING"), "finalize ADJUSTING");
  const svc = read("src/lib/offRequestPhase2Service.ts");
  const teamPage = read("src/app/off-requests/team/page.tsx");
  const teamUi = read("src/app/off-requests/team/OffRequestTeamClient.tsx");
  const adminUi = read("src/app/manage/off-requests/OffRequestAdminClient.tsx");
  const schema = read("prisma/schema.prisma");
  const migDir = fs.readdirSync(path.resolve("prisma/migrations"));
  assert(svc.includes("resolveLeaderPrimaryTeam"), "leader team from linked caddy");
  assert(svc.includes("isPrimaryTeam"), "PRIMARY team only");
  assert(svc.includes("Serializable"), "serializable tx");
  assert(svc.includes("offRequestAdjustment.create"), "adjustment history");
  assert(svc.includes('type: "OFF"'), "creates Assignment OFF");
  assert(svc.includes("alreadyFinalized"), "idempotent finalize");
  assert(!svc.includes("lottery"), "no lottery");
  assert(!svc.includes("UNSELECTED"), "does not mass-use UNSELECTED");
  assert(teamPage.includes('auth.role !== "leader"'), "team page leader only");
  assert(teamUi.includes("/api/off-requests/team/reschedule"), "team reschedule API");
  assert(teamUi.includes("/api/off-requests/team/finalize"), "team finalize API");
  assert(teamUi.includes("팀 최종확정"), "finalize CTA");
  assert(teamUi.includes("명 초과"), "over copy");
  assert(adminUi.includes("월 전체 확정"), "admin finalize CTA");
  assert(adminUi.includes("/api/off-requests/window/${window.id}/${path}"), "admin window actions");
  assert(schema.includes("OffRequest_caddyId_date_active_key") || schema.includes("partial unique"), "schema notes partial unique");
  assert(
    !migDir.some((n) => n > "20261001120000_off_request_window" && n.includes("off_request")),
    "no newer off_request migration"
  );
  const cal = read("src/app/off-requests/OffRequestCalendarClient.tsx");
  assert(cal.includes("APPROVED") && cal.includes("확정"), "caddy shows APPROVED");
  const avail = read("src/lib/availabilityEngine.ts");
  assert(avail.includes('"OFF"'), "availability treats Assignment OFF as blocking");
}

async function runLocalDbTests() {
  if (process.env.ALLOW_DB_TEST !== "1") {
    console.log("\n(skip local DB — set ALLOW_DB_TEST=1 + localhost DATABASE_URL to run)");
    return;
  }
  const url = process.env.DATABASE_URL || "";
  assertLocalDatabaseUrl(url);
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  const tag = `off-p2-${Date.now()}`;
  const year = 2118 + (Date.now() % 20);
  const month = `${year}-03`;
  const d10 = `${month}-10`;
  const d11 = `${month}-11`;
  const admin = actorOf("admin", { username: `adm-${tag}`, userId: 1 });

  const created: Array<{ kind: string; id: number }> = [];
  try {
    const caddyA = await prisma.caddy.create({
      data: { name: `A-${tag}`, team: "1조", teamOrder: 1, employmentStatus: "ACTIVE" },
    });
    const caddyB = await prisma.caddy.create({
      data: { name: `B-${tag}`, team: "1조", teamOrder: 2, employmentStatus: "ACTIVE" },
    });
    const caddyC = await prisma.caddy.create({
      data: { name: `C-${tag}`, team: "1조", teamOrder: 3, employmentStatus: "ACTIVE" },
    });
    const otherTeamCaddy = await prisma.caddy.create({
      data: { name: `O-${tag}`, team: "2조", teamOrder: 1, employmentStatus: "ACTIVE" },
    });
    created.push(
      { kind: "caddy", id: caddyA.id },
      { kind: "caddy", id: caddyB.id },
      { kind: "caddy", id: caddyC.id },
      { kind: "caddy", id: otherTeamCaddy.id }
    );

    const leaderUser = await prisma.user.create({
      data: {
        username: `lead1-${tag}`,
        password: "x",
        role: "leader",
        caddyId: caddyA.id,
        managedTeams: ["9조"],
      },
    });
    const otherLeaderUser = await prisma.user.create({
      data: {
        username: `lead2-${tag}`,
        password: "x",
        role: "leader",
        caddyId: otherTeamCaddy.id,
        managedTeams: ["1조"],
      },
    });
    const caddyUser = await prisma.user.create({
      data: {
        username: `cad-${tag}`,
        password: "x",
        role: "caddy",
        caddyId: caddyB.id,
      },
    });
    created.push(
      { kind: "user", id: leaderUser.id },
      { kind: "user", id: otherLeaderUser.id },
      { kind: "user", id: caddyUser.id }
    );

    const leader = actorOf("leader", {
      username: leaderUser.username,
      userId: leaderUser.id,
      caddyId: caddyA.id,
      managedTeams: ["9조"],
    });
    const otherLeader = actorOf("leader", {
      username: otherLeaderUser.username,
      userId: otherLeaderUser.id,
      caddyId: otherTeamCaddy.id,
      managedTeams: ["1조"],
    });
    const caddyActor = actorOf("caddy", {
      username: caddyUser.username,
      userId: caddyUser.id,
      caddyId: caddyB.id,
    });

    section("AUTH");
    await expectCode(
      () => getOffRequestLeaderTeamMonth(prisma, caddyActor, month),
      "forbidden",
      "caddy 접근 거부"
    );
    await expectCode(
      () => getOffRequestLeaderTeamMonth(prisma, admin, month),
      "forbidden",
      "admin 팀장 API 거부"
    );
    const window = await createOffRequestWindow(prisma, admin, {
      yearMonth: month,
      openAt: `${year}-02-01T00:00:00.000Z`,
      closeAt: `${year}-02-20T00:00:00.000Z`,
      defaultQuota: 2,
    });
    const teamView = await getOffRequestLeaderTeamMonth(prisma, leader, month);
    assert(teamView.team === "1조", "own team leader 허용 — PRIMARY from caddy");
    assert(teamView.team !== "9조", "managedTeams 무시");
    await expectCode(
      () =>
        rescheduleTeamOffRequest(prisma, otherLeader, {
          id: 1,
          toDate: d11,
        }),
      "not_found",
      "다른 팀 없는 id는 not_found/forbidden 계열"
    );

    section("WINDOW");
    await expectCode(
      () =>
        rescheduleTeamOffRequest(prisma, leader, {
          id: 999999,
          toDate: d11,
        }),
      "not_found",
      "DRAFT missing request"
    );
    await openOffRequestWindow(prisma, admin, window.id);
    await expectCode(
      () => finalizeTeamOffRequests(prisma, leader, { month }),
      "window_not_adjusting",
      "OPEN 확정 금지"
    );
    await closeOffRequestWindow(prisma, admin, window.id);

    const aReq = await prisma.offRequest.create({
      data: { caddyId: caddyA.id, date: normalizeOffDateInput(d10), status: "REQUESTED" },
    });
    const bReq = await prisma.offRequest.create({
      data: { caddyId: caddyB.id, date: normalizeOffDateInput(d10), status: "REQUESTED" },
    });
    const cReq = await prisma.offRequest.create({
      data: { caddyId: caddyC.id, date: normalizeOffDateInput(d10), status: "REQUESTED" },
    });

    section("ADJUST");
    const moved = await rescheduleTeamOffRequest(prisma, leader, {
      id: cReq.id,
      toDate: d11,
    });
    assert(moved.offRequest.date.getTime() === normalizeOffDateInput(d11).getTime(), "own request reschedule");
    const hist = await prisma.offRequestAdjustment.findUnique({
      where: { id: moved.adjustmentId },
    });
    assert(hist?.fromDate.getTime() === normalizeOffDateInput(d10).getTime(), "adjustment from");
    assert(hist?.toDate.getTime() === normalizeOffDateInput(d11).getTime(), "adjustment to");
    assert(hist?.adjustedByUserId === leader.userId, "adjustment actor");
    await expectCode(
      () =>
        rescheduleTeamOffRequest(prisma, leader, {
          id: cReq.id,
          toDate: `${year}-04-01`,
        }),
      "outside_window",
      "target month validation"
    );
    await expectCode(
      () =>
        rescheduleTeamOffRequest(prisma, otherLeader, {
          id: aReq.id,
          toDate: d11,
        }),
      "team_forbidden",
      "다른 팀 leader 거부"
    );

    section("QUOTA");
    const overView = await getOffRequestLeaderTeamMonth(prisma, leader, month);
    const day10ok = overView.allDays.find((d) => d.date === d10);
    const day11ok = overView.allDays.find((d) => d.date === d11);
    assert(day10ok?.occupied === 2 && day10ok.limit === 2 && !day10ok.over, "10일 2/2");
    assert(day11ok?.occupied === 1, "11일 1명");
    await prisma.offRequest.update({
      where: { id: cReq.id },
      data: { date: normalizeOffDateInput(d10) },
    });
    await expectCode(
      () => finalizeTeamOffRequests(prisma, leader, { month }),
      "quota_exceeded",
      "quota 초과 finalize 실패"
    );
    await prisma.offRequest.update({
      where: { id: cReq.id },
      data: { date: normalizeOffDateInput(d11) },
    });

    section("ASSIGNMENT + finalize 1조");
    const fin1 = await finalizeTeamOffRequests(prisma, leader, { month });
    assert(fin1.alreadyFinalized === false, "quota 이하 finalize 성공");
    assert(fin1.assignmentIds.length === 3, "Assignment(OFF) 3건");
    const offs = await prisma.assignment.findMany({
      where: { id: { in: fin1.assignmentIds } },
    });
    assert(offs.every((o) => o.type === "OFF"), "OFF type");
    const approved = await prisma.offRequest.findMany({
      where: { id: { in: [aReq.id, bReq.id, cReq.id] } },
    });
    assert(approved.every((r) => r.status === "APPROVED"), "REQUESTED → APPROVED");
    const again = await finalizeTeamOffRequests(prisma, leader, { month });
    assert(again.alreadyFinalized === true, "idempotent already finalized");
    const offCount = await prisma.assignment.count({
      where: { comment: { contains: `OffRequest#${aReq.id}` } },
    });
    assert(offCount === 1, "중복 Assignment 없음");
    const afterFin = await getOffRequestLeaderTeamMonth(prisma, leader, month);
    assert(afterFin.finalization != null, "finalization visible");
    assert(!afterFin.canAdjust && !afterFin.canFinalize, "locked after finalize");
    const listed = afterFin.days.flatMap((d) => d.requests);
    assert(listed.length === 3, "확정 후 APPROVED 3명 표시");
    assert(
      listed.every((r) => r.status === "APPROVED"),
      "확정 후 목록은 APPROVED"
    );

    await expectCode(
      () =>
        rescheduleTeamOffRequest(prisma, leader, {
          id: aReq.id,
          toDate: d11,
        }),
      "team_finalized",
      "finalized team 변경 금지"
    );

    section("CONFLICT + zero-request + concurrency");
    const month2 = `${year}-04`;
    const d20 = `${month2}-20`;
    const window2 = await createOffRequestWindow(prisma, admin, {
      yearMonth: month2,
      openAt: `${year}-03-01T00:00:00.000Z`,
      closeAt: `${year}-03-20T00:00:00.000Z`,
      defaultQuota: 5,
    });
    await openOffRequestWindow(prisma, admin, window2.id);
    await closeOffRequestWindow(prisma, admin, window2.id);

    const conflictCaddy = await prisma.caddy.create({
      data: { name: `X-${tag}`, team: "1조", teamOrder: 8, employmentStatus: "ACTIVE" },
    });
    created.push({ kind: "caddy", id: conflictCaddy.id });
    const { startDate, endDate } = offAssignmentDayRange(d20);
    await prisma.assignment.create({
      data: {
        caddyId: conflictCaddy.id,
        type: "DUTY",
        startDate,
        endDate,
        comment: `duty-${tag}`,
      },
    });
    const conflictReq = await prisma.offRequest.create({
      data: { caddyId: conflictCaddy.id, date: normalizeOffDateInput(d20), status: "REQUESTED" },
    });
    await expectCode(
      () => finalizeTeamOffRequests(prisma, leader, { month: month2 }),
      "assignment_conflict",
      "기존 work assignment 충돌 BLOCK"
    );
    await prisma.offRequest.update({
      where: { id: conflictReq.id },
      data: { status: "CANCELLED" },
    });

    const zero = await finalizeTeamOffRequests(prisma, otherLeader, { month: month2 });
    assert(zero.approvedCount === 0, "zero request team finalize");
    assert(zero.finalization.team === "2조", "2조 TeamFinalization");

    const req2 = await prisma.offRequest.create({
      data: { caddyId: caddyA.id, date: normalizeOffDateInput(`${month2}-21`), status: "REQUESTED" },
    });
    const [r1, r2] = await Promise.allSettled([
      finalizeTeamOffRequests(prisma, leader, { month: month2 }),
      finalizeTeamOffRequests(prisma, leader, { month: month2 }),
    ]);
    const oks = [r1, r2].filter((r) => r.status === "fulfilled");
    const already = [r1, r2].filter(
      (r) =>
        r.status === "fulfilled" &&
        (r as PromiseFulfilledResult<Awaited<ReturnType<typeof finalizeTeamOffRequests>>>).value
          .alreadyFinalized
    );
    const createdOnce =
      oks.length === 2
        ? already.length === 1
        : oks.length === 1;
    assert(createdOnce, "double finalize 한쪽만 생성");
    const afterReq = await prisma.offRequest.findUnique({ where: { id: req2.id } });
    assert(afterReq?.status === "APPROVED", "동시 확정 후 APPROVED");
    const finRows = await prisma.offRequestTeamFinalization.count({
      where: { windowId: window2.id, team: "1조" },
    });
    assert(finRows === 1, "TeamFinalization 1건");

    const req3 = await prisma.offRequest.create({
      data: { caddyId: caddyB.id, date: normalizeOffDateInput(`${month2}-22`), status: "REQUESTED" },
    });
    await expectCode(
      () =>
        rescheduleTeamOffRequest(prisma, leader, {
          id: req3.id,
          toDate: `${month2}-23`,
        }),
      "team_finalized",
      "확정 후 늦은 adjustment BLOCK"
    );
    await prisma.offRequest.update({
      where: { id: req3.id },
      data: { status: "CANCELLED" },
    });

    section("ADMIN");
    const progress = await getOffRequestAdminProgress(prisma, month);
    assert(progress.teamCount === 12, "progress 12 teams");
    assert(progress.finalizedCount === 1, "1조만 확정된 3월");
    await expectCode(
      () => finalizeOffRequestWindow(prisma, admin, window.id),
      "teams_incomplete",
      "미확정 팀 있으면 전체확정 BLOCK"
    );

    // 3월 나머지 팀 zero-finalize 는 시간이 큼. 4월은 1조+2조만 확정.
    const p2 = await getOffRequestAdminProgress(prisma, month2);
    assert(p2.finalizedCount >= 2, "4월 최소 2팀 확정");
    await expectCode(
      () => finalizeOffRequestWindow(prisma, admin, window2.id),
      "teams_incomplete",
      "4월도 12팀 미달 BLOCK"
    );

    // 나머지 PRIMARY 팀 zero-finalize (같은 otherLeader는 2조만). 관리자 시드 finalization rows.
    const remaining = p2.teams.filter((t) => !t.finalized).map((t) => t.team);
    await prisma.offRequestTeamFinalization.createMany({
      data: remaining.map((team) => ({
        windowId: window2.id,
        team,
        finalizedAt: new Date(),
        finalizedByUserId: admin.userId,
      })),
    });
    const done = await finalizeOffRequestWindow(prisma, admin, window2.id);
    assert(done.status === "FINALIZED", "전팀 확정 후 FINALIZED 성공");
    await expectCode(
      () => finalizeOffRequestWindow(prisma, admin, window2.id),
      "invalid_transition",
      "FINALIZED 후 재확정 금지"
    );
    await expectCode(
      () =>
        rescheduleTeamOffRequest(prisma, leader, {
          id: req2.id,
          toDate: `${month2}-24`,
        }),
      "window_not_adjusting",
      "FINALIZED 후 수정 금지"
    );

    const leftover = await prisma.offRequest.findUnique({ where: { id: req2.id } });
    assert(leftover?.status === "APPROVED", "caddy APPROVED 결과 유지");

    section("OVERRIDE QUOTA");
    const month3 = `${year}-05`;
    const d05 = `${month3}-05`;
    const d06 = `${month3}-06`;
    const window3 = await createOffRequestWindow(prisma, admin, {
      yearMonth: month3,
      openAt: `${year}-04-01T00:00:00.000Z`,
      closeAt: `${year}-04-20T00:00:00.000Z`,
      defaultQuota: 5,
    });
    await upsertOffRequestQuota(prisma, admin, {
      month: month3,
      team: "1조",
      date: d05,
      limit: 1,
    });
    await openOffRequestWindow(prisma, admin, window3.id);
    await closeOffRequestWindow(prisma, admin, window3.id);
    const o1 = await prisma.offRequest.create({
      data: { caddyId: caddyA.id, date: normalizeOffDateInput(d05), status: "REQUESTED" },
    });
    const o2 = await prisma.offRequest.create({
      data: { caddyId: caddyB.id, date: normalizeOffDateInput(d05), status: "REQUESTED" },
    });
    await expectCode(
      () => finalizeTeamOffRequests(prisma, leader, { month: month3 }),
      "quota_exceeded",
      "override quota 적용"
    );
    await rescheduleTeamOffRequest(prisma, leader, { id: o2.id, toDate: d06 });
    const finOverride = await finalizeTeamOffRequests(prisma, leader, { month: month3 });
    assert(finOverride.assignmentIds.length === 2, "override 해소 후 finalize");
    void o1;

    // cleanup created windows/requests/assignments later
    void leftover;
  } finally {
    // 미래 테스트 월 데이터만 정리
    try {
      await prisma.offRequestAdjustment.deleteMany({
        where: { offRequest: { caddy: { name: { contains: tag } } } },
      });
      const reqs = await prisma.offRequest.findMany({
        where: { caddy: { name: { contains: tag } } },
        select: { id: true, assignmentId: true },
      });
      await prisma.offRequest.updateMany({
        where: { id: { in: reqs.map((r) => r.id) } },
        data: { assignmentId: null },
      });
      const assignIds = reqs.map((r) => r.assignmentId).filter((id): id is number => id != null);
      if (assignIds.length) {
        await prisma.assignment.deleteMany({ where: { id: { in: assignIds } } });
      }
      await prisma.assignment.deleteMany({
        where: { comment: { contains: tag } },
      });
      await prisma.offRequest.deleteMany({
        where: { caddy: { name: { contains: tag } } },
      });
      await prisma.offRequestTeamFinalization.deleteMany({
        where: { window: { yearMonth: { in: [`${year}-03`, `${year}-04`, `${year}-05`] } } },
      });
      await prisma.offRequestQuota.deleteMany({
        where: { window: { yearMonth: { in: [`${year}-03`, `${year}-04`, `${year}-05`] } } },
      });
      await prisma.offRequestWindow.deleteMany({
        where: { yearMonth: { in: [`${year}-03`, `${year}-04`, `${year}-05`] } },
      });
      await prisma.user.deleteMany({ where: { username: { contains: tag } } });
      await prisma.caddy.deleteMany({ where: { name: { contains: tag } } });
    } catch (e) {
      console.warn("cleanup warning", e);
    }
    await prisma.$disconnect();
  }
}

async function main() {
  await runLocalDbTests();
  console.log(`\nDONE: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
