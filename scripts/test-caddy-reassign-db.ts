/**
 * LOCAL POSTGRESQL ONLY — 캐디관리 V2 일괄 재배치 트랜잭션 테스트
 *
 * DATABASE_URL=postgresql://caddy:caddy@localhost:5432/caddy_local \
 *   npm run test:caddy-reassign-db
 */
import "dotenv/config";
import { Prisma, PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";
import { assertLocalDatabaseUrl } from "./assertLocalDatabaseUrl";
import {
  SESSION_COOKIE_NAME,
  buildSessionClaims,
  signSessionClaims,
} from "../src/lib/sessionCookies";
import { POST as previewPOST } from "../src/app/api/caddies/reassign/preview/route";
import { POST as applyPOST } from "../src/app/api/caddies/reassign/apply/route";
import {
  applyCaddyReassign,
  parseCaddyReassignRequest,
} from "../src/lib/caddyReassignApply";
import {
  CADDY_REASSIGN_AUDIT_ACTION,
  CaddyReassignError,
  planCaddyReassign,
} from "../src/lib/caddyReassign";
import {
  findSlotHoldingConflicts,
  isSlotHoldingStatus,
} from "../src/lib/caddySlot";
import { occupiesHouseThirdSlot } from "../src/lib/caddyManage";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET ||
  process.env.NEXTAUTH_SECRET ||
  "reassign-v2-test-secret-32chars-min!!";

const TAG = "__REASSIGN_V2__";
const prisma = new PrismaClient();

let passed = 0;
let failed = 0;

function assert(cond: unknown, msg: string) {
  if (cond) {
    passed += 1;
    console.log("  ✓", msg);
  } else {
    failed += 1;
    console.error("  ✗", msg);
  }
}

function section(title: string) {
  console.log("\n==", title, "==");
}

async function adminReq(url: string, body: unknown) {
  const token = await signSessionClaims(
    buildSessionClaims({
      userId: null,
      username: "admin",
      role: "admin",
      sessionVersion: 0,
    })
  );
  return new NextRequest(url, {
    method: "POST",
    headers: {
      cookie: `${SESSION_COOKIE_NAME}=${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

type SlotRow = {
  id: number;
  team: string;
  teamOrder: number;
  employmentStatus: string;
  caddyType: string | null;
};

function teamAnomalies(rows: SlotRow[], team: string) {
  const holders = rows.filter(
    (row) =>
      row.team === team &&
      occupiesHouseThirdSlot(row) &&
      isSlotHoldingStatus(row.employmentStatus)
  );
  const unspecified = holders.filter((row) => !row.teamOrder || row.teamOrder < 1);
  const conflicts = findSlotHoldingConflicts(
    holders.map((row) => ({
      id: row.id,
      name: String(row.id),
      team: row.team,
      teamOrder: row.teamOrder,
      emp: row.employmentStatus,
      caddyType: row.caddyType,
    }))
  );
  return { unspecified, conflicts };
}

function emptySlots(rows: SlotRow[], team: string, max = 24): number[] {
  const used = new Set(
    rows
      .filter(
        (row) =>
          row.team === team &&
          occupiesHouseThirdSlot(row) &&
          isSlotHoldingStatus(row.employmentStatus) &&
          row.teamOrder >= 1
      )
      .map((row) => row.teamOrder)
  );
  const empty: number[] = [];
  for (let i = 1; i <= max; i++) {
    if (!used.has(i)) empty.push(i);
  }
  return empty;
}

async function loadSlots(): Promise<SlotRow[]> {
  const rows = await prisma.caddy.findMany({
    select: {
      id: true,
      team: true,
      teamOrder: true,
      employmentStatus: true,
      caddyType: true,
    },
  });
  return rows;
}

async function cleanup() {
  const tagged = await prisma.caddy.findMany({
    where: { name: { startsWith: TAG } },
    select: { id: true },
  });
  const ids = tagged.map((row) => row.id);
  if (ids.length === 0) return;
  await prisma.audit.deleteMany({
    where: { action: CADDY_REASSIGN_AUDIT_ACTION, entityId: { in: ids } },
  });
  await prisma.assignment.deleteMany({ where: { caddyId: { in: ids } } });
  await prisma.schedule.deleteMany({ where: { caddyId: { in: ids } } });
  await prisma.user.deleteMany({ where: { caddyId: { in: ids } } });
  await prisma.cart.deleteMany({ where: { ownerCaddyId: { in: ids } } });
  await prisma.marshalProfile.deleteMany({ where: { caddyId: { in: ids } } });
  await prisma.caddy.deleteMany({ where: { id: { in: ids } } });
}

async function main() {
  assertLocalDatabaseUrl(process.env.DATABASE_URL);
  await cleanup();

  const createdIds: number[] = [];
  try {
    section("fixture: empty slots on clean teams");
    const before = await loadSlots();
    const houseTeam =
      ["1조", "2조", "3조", "4조", "5조", "6조", "7조", "8조"].find((team) => {
        const a = teamAnomalies(before, team);
        return a.conflicts.length === 0 && emptySlots(before, team).length >= 9;
      }) ?? null;
    const thirdTeam =
      ["9조", "10조", "11조", "12조"].find((team) => {
        const a = teamAnomalies(before, team);
        return a.conflicts.length === 0 && emptySlots(before, team).length >= 4;
      }) ?? null;
    assert(houseTeam != null, "found clean house team");
    assert(thirdTeam != null, "found clean third team");
    if (!houseTeam || !thirdTeam) {
      throw new Error("clean teams required for local reassign db test");
    }
    const houseEmpty = emptySlots(before, houseTeam);
    const thirdEmpty = emptySlots(before, thirdTeam);
    const slots = {
      a: houseEmpty[0],
      b: houseEmpty[1],
      c: houseEmpty[2],
      leave: houseEmpty[3],
      dest: houseEmpty[4],
      zero: houseEmpty[5],
      dup: houseEmpty[6],
      dupMove: houseEmpty[7],
      stale: houseEmpty[8],
      t1: thirdEmpty[0],
      t2: thirdEmpty[1],
    };

    const [a, b, c, leave, t1, t2] = await prisma.$transaction([
      prisma.caddy.create({
        data: {
          name: `${TAG}A`,
          team: houseTeam,
          teamOrder: slots.a,
          employmentStatus: "ACTIVE",
          caddyType: "HOUSE",
        },
      }),
      prisma.caddy.create({
        data: {
          name: `${TAG}B`,
          team: houseTeam,
          teamOrder: slots.b,
          employmentStatus: "ACTIVE",
          caddyType: "HOUSE",
        },
      }),
      prisma.caddy.create({
        data: {
          name: `${TAG}C`,
          team: houseTeam,
          teamOrder: slots.c,
          employmentStatus: "ACTIVE",
          caddyType: "HOUSE",
        },
      }),
      prisma.caddy.create({
        data: {
          name: `${TAG}LEAVE`,
          team: houseTeam,
          teamOrder: slots.leave,
          employmentStatus: "LEAVE",
          caddyType: "HOUSE",
        },
      }),
      prisma.caddy.create({
        data: {
          name: `${TAG}T1`,
          team: thirdTeam,
          teamOrder: slots.t1,
          employmentStatus: "ACTIVE",
          caddyType: "THIRD",
          thirdBandSubgroup: "WEEKDAY",
        },
      }),
      prisma.caddy.create({
        data: {
          name: `${TAG}T2`,
          team: thirdTeam,
          teamOrder: slots.t2,
          employmentStatus: "ACTIVE",
          caddyType: "THIRD",
        },
      }),
    ]);
    createdIds.push(a.id, b.id, c.id, leave.id, t1.id, t2.id);

    const relatedCaddy = a;
    const assignment = await prisma.assignment.create({
      data: {
        caddyId: relatedCaddy.id,
        type: "OFF",
        startDate: new Date("2099-01-01T00:00:00.000Z"),
        endDate: new Date("2099-01-02T00:00:00.000Z"),
        comment: `${TAG}off`,
      },
    });
    const schedule = await prisma.schedule.create({
      data: {
        caddyId: relatedCaddy.id,
        date: new Date("2099-01-03T00:00:00.000Z"),
        memo: `${TAG}sched`,
      },
    });
    const user = await prisma.user.create({
      data: {
        username: `${TAG}user`,
        password: "x",
        role: "caddy",
        caddyId: relatedCaddy.id,
        kakaoUserId: `kakao-${TAG}`,
      },
    });
    const cart = await prisma.cart.create({
      data: {
        number: `${TAG}CART`,
        ownerCaddyId: relatedCaddy.id,
      },
    });
    const marshal = await prisma.marshalProfile.create({
      data: {
        caddyId: relatedCaddy.id,
        startedOn: new Date("2020-01-01T00:00:00.000Z"),
        rotationOrder: 9801,
        active: true,
      },
    });

    section("preview + 같은 조 순번 이동 apply");
    const swapBody = {
      placements: [
        { id: a.id, team: houseTeam, teamOrder: slots.b },
        { id: b.id, team: houseTeam, teamOrder: slots.a },
      ],
      mode: "explicit" as const,
    };
    const previewRes = await previewPOST(await adminReq("http://local/api/caddies/reassign/preview", swapBody));
    const previewJson = await previewRes.json();
    assert(previewRes.status === 200 && previewJson.ok === true, "preview swap ok");
    assert(
      previewJson.requestedIds.includes(a.id) &&
        previewJson.changes.some((ch: { id: number; from: { teamOrder: number } }) => ch.id === a.id),
      "preview reports ids and before/after"
    );
    const applyRes = await applyPOST(
      await adminReq("http://caddy.local/api/caddies/reassign/apply", {
        ...swapBody,
        base: previewJson.base,
      })
    );
    const applyJson = await applyRes.json();
    assert(applyRes.status === 200 && applyJson.ok === true, "apply swap 200");
    const swapped = await prisma.caddy.findMany({
      where: { id: { in: [a.id, b.id] } },
    });
    const aAfter = swapped.find((row) => row.id === a.id)!;
    const bAfter = swapped.find((row) => row.id === b.id)!;
    assert(aAfter.teamOrder === slots.b && bAfter.teamOrder === slots.a, "orders swapped");
    assert(aAfter.id === a.id && bAfter.id === b.id, "caddy ids preserved");

    const audit = await prisma.audit.findFirst({
      where: { action: CADDY_REASSIGN_AUDIT_ACTION, entityId: a.id },
      orderBy: { id: "desc" },
    });
    assert(audit != null, "audit row written");
    const payload = (audit?.payload ?? {}) as {
      requestedIds?: number[];
      changes?: Array<{ id: number; from: { team: string; teamOrder: number }; to: { team: string; teamOrder: number } }>;
    };
    assert(
      payload.requestedIds?.includes(a.id) &&
        payload.changes?.some((ch) => ch.id === a.id && ch.from.teamOrder === slots.a),
      "audit includes before/after teamOrder"
    );

    section("3부반 → 하우스");
    const thirdMove = {
      placements: [{ id: t1.id, team: houseTeam, teamOrder: slots.dest }],
      mode: "explicit" as const,
    };
    const thirdPreview = await (
      await previewPOST(await adminReq("http://local/preview", thirdMove))
    ).json();
    assert(thirdPreview.ok === true, "third→house preview ok");
    const thirdApply = await applyPOST(
      await adminReq("http://local/apply", { ...thirdMove, base: thirdPreview.base })
    );
    const thirdJson = await thirdApply.json();
    assert(thirdApply.status === 200 && thirdJson.ok === true, "third→house applied");
    const t1After = await prisma.caddy.findUniqueOrThrow({ where: { id: t1.id } });
    assert(
      t1After.team === houseTeam &&
        t1After.teamOrder === slots.dest &&
        t1After.caddyType === "HOUSE" &&
        t1After.thirdBandSubgroup == null,
      "THIRD→HOUSE invariant"
    );
    assert(t1After.id === t1.id, "third caddy id preserved");

    section("조 사이 맞교환 + 여러 명");
    const cross = {
      placements: [
        { id: t1.id, team: thirdTeam, teamOrder: slots.t1 },
        { id: t2.id, team: houseTeam, teamOrder: slots.dest },
        { id: c.id, team: houseTeam, teamOrder: slots.c },
      ],
      mode: "explicit" as const,
    };
    const crossPreview = await (
      await previewPOST(await adminReq("http://local/preview", cross))
    ).json();
    assert(crossPreview.ok === true, "cross preview ok");
    const crossApply = await applyPOST(
      await adminReq("http://local/apply", { ...cross, base: crossPreview.base })
    );
    assert(crossApply.status === 200, "cross apply 200");
    const t1Back = await prisma.caddy.findUniqueOrThrow({ where: { id: t1.id } });
    const t2Moved = await prisma.caddy.findUniqueOrThrow({ where: { id: t2.id } });
    assert(t1Back.team === thirdTeam && t1Back.caddyType === "THIRD", "T1 returned to third");
    assert(t2Moved.team === houseTeam && t2Moved.caddyType === "HOUSE", "T2 now house");

    section("휴직자 슬롯 보호");
    const ontoLeave = {
      placements: [{ id: c.id, team: houseTeam, teamOrder: slots.leave }],
      mode: "explicit" as const,
    };
    const ontoLeavePreview = await (
      await previewPOST(await adminReq("http://local/preview", ontoLeave))
    ).json();
    assert(ontoLeavePreview.ok === false, "preview blocks landing on LEAVE");
    const ontoLeaveApply = await applyPOST(
      await adminReq("http://local/apply", {
        ...ontoLeave,
        base: ontoLeavePreview.base,
      })
    );
    assert(ontoLeaveApply.status === 409, "apply LEAVE conflict 409");
    const cUnchanged = await prisma.caddy.findUniqueOrThrow({ where: { id: c.id } });
    assert(cUnchanged.teamOrder === slots.c, "LEAVE conflict did not move C");

    section("teamOrder=0 / 중복 / 정원 초과");
    const zero = await prisma.caddy.create({
      data: {
        name: `${TAG}ZERO`,
        team: houseTeam,
        teamOrder: 0,
        employmentStatus: "ACTIVE",
        caddyType: "HOUSE",
      },
    });
    createdIds.push(zero.id);
    const zeroPreview = await (
      await previewPOST(
        await adminReq("http://local/preview", {
          placements: [{ id: c.id, team: houseTeam, teamOrder: slots.stale }],
        })
      )
    ).json();
    assert(zeroPreview.ok === true, "unmoved teamOrder=0 does not block numbered moves");
    assert(
      Array.isArray(zeroPreview.existingAnomalies) &&
        zeroPreview.existingAnomalies.some(
          (issue: { code: string; caddyIds?: number[] }) =>
            issue.code === "existing_unspecified_order" &&
            issue.caddyIds?.includes(zero.id)
        ),
      "preview reports the unspecified caddy"
    );
    const zeroStill = await prisma.caddy.findUniqueOrThrow({ where: { id: zero.id } });
    assert(zeroStill.teamOrder === 0, "Zero was not auto-renumbered by preview");
    await prisma.caddy.update({
      where: { id: zero.id },
      data: { teamOrder: slots.zero },
    });

    const overflowPreview = await (
      await previewPOST(
        await adminReq("http://local/preview", {
          placements: [{ id: c.id, team: houseTeam, teamOrder: 25 }],
        })
      )
    ).json();
    assert(overflowPreview.ok === false, "capacity 25 blocked");

    const dupA = await prisma.caddy.create({
      data: {
        name: `${TAG}DUPA`,
        team: houseTeam,
        teamOrder: slots.dup,
        employmentStatus: "ACTIVE",
        caddyType: "HOUSE",
      },
    });
    const dupB = await prisma.caddy.create({
      data: {
        name: `${TAG}DUPB`,
        team: houseTeam,
        teamOrder: slots.dup,
        employmentStatus: "ACTIVE",
        caddyType: "HOUSE",
      },
    });
    createdIds.push(dupA.id, dupB.id);
    const dupPreview = await (
      await previewPOST(
        await adminReq("http://local/preview", {
          placements: [{ id: c.id, team: houseTeam, teamOrder: slots.c }],
        })
      )
    ).json();
    assert(dupPreview.ok === false, "existing duplicate reported, not auto-fixed");
    await prisma.caddy.update({
      where: { id: dupB.id },
      data: { teamOrder: slots.dupMove },
    });

    section("동시 수정 409");
    const staleBody = {
      placements: [{ id: c.id, team: houseTeam, teamOrder: slots.stale }],
    };
    const stalePreview = await (
      await previewPOST(await adminReq("http://local/preview", staleBody))
    ).json();
    assert(stalePreview.ok === true, "stale preview ok before concurrent edit");
    await prisma.caddy.update({
      where: { id: b.id },
      data: { memo: `${TAG}touch` },
    });
    const staleApply = await applyPOST(
      await adminReq("http://local/apply", {
        ...staleBody,
        base: stalePreview.base,
      })
    );
    const staleJson = await staleApply.json();
    assert(staleApply.status === 409 && staleJson.code === "stale_roster", "stale apply 409");
    const cStill = await prisma.caddy.findUniqueOrThrow({ where: { id: c.id } });
    assert(cStill.teamOrder === slots.c, "stale apply did not move C");

    section("트랜잭션 전체 롤백");
    const freshPreview = await (
      await previewPOST(await adminReq("http://local/preview", staleBody))
    ).json();
    const parsed = parseCaddyReassignRequest({
      ...staleBody,
      base: freshPreview.base,
    });
    const rollbackDb = {
      $transaction: <T,>(
        fn: (tx: any) => Promise<T>,
        options?: { maxWait?: number; timeout?: number }
      ) =>
        prisma.$transaction(async (tx) => {
          return fn({
            $queryRaw: (query: Prisma.Sql) => tx.$queryRaw(query),
            $executeRaw: async (query: Prisma.Sql) => {
              await tx.$executeRaw(query);
              throw new Error("forced failure after batch update");
            },
            audit: tx.audit,
          });
        }, options),
    };
    try {
      await applyCaddyReassign({
        db: rollbackDb as any,
        placements: parsed.placements,
        mode: parsed.mode,
        base: parsed.base,
      });
      assert(false, "rollback apply should throw");
    } catch (error) {
      assert(
        error instanceof CaddyReassignError && error.code === "apply_failed",
        "forced failure maps to apply_failed"
      );
    }
    const rolled = await prisma.caddy.findUniqueOrThrow({ where: { id: c.id } });
    assert(rolled.teamOrder === slots.c, "update rolled back");

    section("연관 데이터 / 자동배치 엔진 데이터 유지");
    const assignmentAfter = await prisma.assignment.findUniqueOrThrow({
      where: { id: assignment.id },
    });
    const scheduleAfter = await prisma.schedule.findUniqueOrThrow({
      where: { id: schedule.id },
    });
    const userAfter = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    const cartAfter = await prisma.cart.findUniqueOrThrow({ where: { id: cart.id } });
    const marshalAfter = await prisma.marshalProfile.findUniqueOrThrow({
      where: { id: marshal.id },
    });
    assert(assignmentAfter.caddyId === a.id && assignmentAfter.comment === `${TAG}off`, "assignment kept");
    assert(scheduleAfter.caddyId === a.id && scheduleAfter.memo === `${TAG}sched`, "schedule kept");
    assert(userAfter.caddyId === a.id && userAfter.kakaoUserId === `kakao-${TAG}`, "user/kakao kept");
    assert(cartAfter.ownerCaddyId === a.id, "cart ownership kept");
    assert(
      marshalAfter.caddyId === a.id && marshalAfter.rotationOrder === 9801,
      "marshal profile/order kept"
    );

    const enginePlan = planCaddyReassign(
      [
        {
          id: a.id,
          name: a.name,
          team: aAfter.team,
          teamOrder: aAfter.teamOrder,
          employmentStatus: "ACTIVE",
          caddyType: "HOUSE",
        },
      ],
      [{ id: a.id, team: aAfter.team, teamOrder: aAfter.teamOrder }]
    );
    assert(enginePlan.ok, "no-op plan still valid after apply");
  } finally {
    await cleanup();
  }

  console.log(`\nDONE: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
