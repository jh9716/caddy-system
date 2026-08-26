/**
 * OffRequest service/API 단위 + (선택) 로컬 DB 통합 테스트
 *
 * ⛔ Production/Neon write 금지.
 *
 * 순수 mock:
 *   npx tsx scripts/test-off-request-api-unit.ts
 *
 * 로컬 DB:
 *   ALLOW_DB_TEST=1 DATABASE_URL=postgresql://caddy:caddy@localhost:5432/caddy_local?schema=public \
 *     npx tsx scripts/test-off-request-api-unit.ts
 */
import { PrismaClient } from "@prisma/client";
import {
  canApproveAgainstQuota,
  computeOffQuotaSnapshot,
  formatOffDateYmd,
  normalizeOffDateInput,
  offAssignmentDayRange,
} from "../src/lib/offRequestDomain";
import type { OffRequestActor } from "../src/lib/offRequestAuth";
import {
  OffRequestServiceError,
  approveOffRequest,
  cancelOwnOffRequest,
  countApprovedOffForTeamDay,
  rejectOffRequest,
  revokeOffRequest,
  serializeOffRequest,
  submitOffRequest,
} from "../src/lib/offRequestService";
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
section("serialize + quota gate (pure)");
{
  const snap = computeOffQuotaSnapshot({ approvedCount: 5, requestedCount: 2 });
  assert(snap.overQuota === true, "5 already over/at quota");
  assert(snap.approveWouldExceedQuota === true, "next approve needs confirm");
  const gate = canApproveAgainstQuota({ approvedCount: 5, confirmOverQuota: false });
  assert(gate.ok === false, "block without confirm");
  const gate2 = canApproveAgainstQuota({ approvedCount: 5, confirmOverQuota: true });
  assert(gate2.ok === true && gate2.requiresConfirm === true, "allow with confirm");
  const gate3 = canApproveAgainstQuota({ approvedCount: 4 });
  assert(gate3.ok === true && gate3.requiresConfirm === false, "under quota free");

  const ser = serializeOffRequest({
    id: 1,
    caddyId: 2,
    date: normalizeOffDateInput("2026-09-01"),
    status: "REQUESTED",
    requestedAt: new Date("2026-08-01T00:00:00Z"),
    note: "x",
    decidedAt: null,
    decidedByUserId: null,
    decisionNote: null,
    assignmentId: null,
    createdAt: new Date("2026-08-01T00:00:00Z"),
    updatedAt: new Date("2026-08-01T00:00:00Z"),
  } as any);
  assert(ser.date === "2026-09-01", "serialize date ymd");
  assert(ser.status === "REQUESTED", "serialize status");
}

section("service auth guards (no DB)");
{
  const caddy: OffRequestActor = {
    role: "caddy",
    username: "c1",
    userId: 1,
    caddyId: null,
    managedTeams: [],
  };
  let code = "";
  try {
    await submitOffRequest({} as any, caddy, { date: "2026-09-01" });
  } catch (e) {
    code = e instanceof OffRequestServiceError ? e.code : "other";
  }
  assert(code === "caddy_not_linked", "submit requires caddyId");

  const leaderNoUser: OffRequestActor = {
    role: "leader",
    username: "l1",
    userId: null,
    caddyId: null,
    managedTeams: ["1조"],
  };
  code = "";
  try {
    await approveOffRequest({} as any, leaderNoUser, 1, {});
  } catch (e) {
    code = e instanceof OffRequestServiceError ? e.code : "other";
  }
  assert(code === "user_required", "leader approve needs userId");
}

// ─── Optional local DB integration ─────────────────────────────────
async function runLocalDbTests() {
  if (process.env.ALLOW_DB_TEST !== "1") {
    console.log("\n(skip local DB — set ALLOW_DB_TEST=1 + localhost DATABASE_URL to run)");
    return;
  }
  const url = process.env.DATABASE_URL || "";
  assertLocalDatabaseUrl(url);

  section("local DB: submit → approve → revoke (linked OFF only)");
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  const tag = `off-api-test-${Date.now()}`;
  const ymd = "2099-01-15"; // far-future isolation
  const { startDate, endDate } = offAssignmentDayRange(ymd);

  try {
    const team = `T-${tag}`;
    const caddy = await prisma.caddy.create({
      data: {
        name: `C-${tag}`,
        team,
        teamOrder: 1,
        employmentStatus: "ACTIVE",
      },
    });
    const caddy2 = await prisma.caddy.create({
      data: {
        name: `C2-${tag}`,
        team,
        teamOrder: 2,
        employmentStatus: "ACTIVE",
      },
    });
    // 수동/레거시 OFF (OffRequest 미연결) — revoke 대상이 되면 안 됨
    const manualOff = await prisma.assignment.create({
      data: {
        caddyId: caddy2.id,
        type: "OFF",
        startDate,
        endDate,
        comment: `manual-${tag}`,
      },
    });

    const leaderUser = await prisma.user.create({
      data: {
        username: `leader-${tag}`,
        password: "x",
        role: "leader",
        managedTeams: [team, "other-unused"],
      },
    });
    const caddyUser = await prisma.user.create({
      data: {
        username: `caddy-${tag}`,
        password: "x",
        role: "caddy",
        caddyId: caddy.id,
      },
    });

    const caddyActor: OffRequestActor = {
      role: "caddy",
      username: caddyUser.username,
      userId: caddyUser.id,
      caddyId: caddy.id,
      managedTeams: [],
    };
    const leaderActor: OffRequestActor = {
      role: "leader",
      username: leaderUser.username,
      userId: leaderUser.id,
      caddyId: null,
      managedTeams: [team, "other-unused"],
    };

    const created = await submitOffRequest(prisma, caddyActor, {
      date: ymd,
      note: "unit",
    });
    assert(created.status === "REQUESTED", "created REQUESTED");
    assert(created.assignmentId == null, "no Assignment on REQUESTED");

    // quota: 이미 수동 OFF 1건 → approvedCount 1
    const before = await countApprovedOffForTeamDay(prisma, team, ymd);
    assert(before === 1, "quota includes manual OFF");

    // 정원 채우기용 추가 수동 OFF 4건 (총 5) 후 초과 확인 필요
    const fillers = [];
    for (let i = 0; i < 4; i++) {
      const fc = await prisma.caddy.create({
        data: {
          name: `F${i}-${tag}`,
          team,
          teamOrder: 10 + i,
          employmentStatus: "ACTIVE",
        },
      });
      fillers.push(fc);
      await prisma.assignment.create({
        data: {
          caddyId: fc.id,
          type: "OFF",
          startDate,
          endDate,
          comment: `fill-${tag}`,
        },
      });
    }
    const atQuota = await countApprovedOffForTeamDay(prisma, team, ymd);
    assert(atQuota === 5, "5 manual OFF = at quota");

    let blocked = false;
    try {
      await approveOffRequest(prisma, leaderActor, created.id, {
        confirmOverQuota: false,
      });
    } catch (e) {
      blocked =
        e instanceof OffRequestServiceError &&
        e.code === "quota_exceeded_confirm_required";
    }
    assert(blocked, "over-quota requires confirmOverQuota");

    const approved = await approveOffRequest(prisma, leaderActor, created.id, {
      confirmOverQuota: true,
      decisionNote: "ok over",
    });
    assert(approved.offRequest.status === "APPROVED", "approved");
    assert(approved.offRequest.assignmentId != null, "has assignmentId");
    assert(approved.overQuotaApproved === true, "flag overQuotaApproved");

    const linkedId = approved.offRequest.assignmentId!;
    const linked = await prisma.assignment.findUnique({ where: { id: linkedId } });
    assert(linked?.type === "OFF", "Assignment OFF created");
    assert(linked?.comment?.includes(`OffRequest#${created.id}`), "comment links request");

    // 다른 조 leader는 반려/취소 불가
    const otherLeader: OffRequestActor = {
      role: "leader",
      username: "x",
      userId: leaderUser.id,
      caddyId: null,
      managedTeams: ["ZZ-nope"],
    };
    let teamForbidden = false;
    try {
      await rejectOffRequest(prisma, otherLeader, created.id, {});
    } catch (e) {
      // already APPROVED — invalid_transition or if we had REQUESTED would be team_forbidden
      // Use a fresh REQUESTED for team check
    }
    const extraCaddy = await prisma.caddy.create({
      data: {
        name: `EX-${tag}`,
        team,
        teamOrder: 99,
        employmentStatus: "ACTIVE",
      },
    });
    const extraReq = await prisma.offRequest.create({
      data: {
        caddyId: extraCaddy.id,
        date: normalizeOffDateInput(ymd),
        status: "REQUESTED",
        note: "extra",
      },
    });
    try {
      await rejectOffRequest(prisma, otherLeader, extraReq.id, {});
    } catch (e) {
      teamForbidden =
        e instanceof OffRequestServiceError && e.code === "team_forbidden";
    }
    assert(teamForbidden, "other team leader cannot reject");

    // cancel own REQUESTED
    const cancelable = await prisma.offRequest.create({
      data: {
        caddyId: caddy.id,
        date: normalizeOffDateInput("2099-01-16"),
        status: "REQUESTED",
      },
    });
    const cancelled = await cancelOwnOffRequest(prisma, caddyActor, cancelable.id);
    assert(cancelled.status === "CANCELLED", "own cancel");
    const stillThere = await prisma.offRequest.findUnique({
      where: { id: cancelable.id },
    });
    assert(stillThere != null, "no physical delete on cancel");

    // revoke: linked OFF deleted, manual OFF untouched
    const revoked = await revokeOffRequest(prisma, leaderActor, created.id);
    assert(revoked.status === "CANCELLED", "revoked → CANCELLED");
    assert(revoked.assignmentId == null, "link cleared");
    assert(revoked.decidedAt != null, "keep decidedAt");
    assert(revoked.decidedByUserId === leaderUser.id, "keep decidedBy");
    assert(revoked.decisionNote === "ok over", "keep decisionNote");
    const linkedGone = await prisma.assignment.findUnique({ where: { id: linkedId } });
    assert(linkedGone == null, "linked Assignment deleted");
    const manualStill = await prisma.assignment.findUnique({
      where: { id: manualOff.id },
    });
    assert(manualStill != null, "manual OFF preserved");

    // cleanup test rows (local only)
    await prisma.offRequest.deleteMany({
      where: { caddy: { team } },
    });
    await prisma.assignment.deleteMany({
      where: { caddy: { team } },
    });
    await prisma.user.deleteMany({
      where: { username: { in: [leaderUser.username, caddyUser.username] } },
    });
    await prisma.caddy.deleteMany({ where: { team } });
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
