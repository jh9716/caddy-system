/**
 * LOCAL POSTGRESQL ONLY — 일괄 재배치 vs POST/PATCH 실제 동시 경합
 *
 * DATABASE_URL=postgresql://caddy:caddy@localhost:5432/caddy_local \
 *   npm run test:caddy-reassign-concurrency-db
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";
import { assertLocalDatabaseUrl } from "./assertLocalDatabaseUrl";
import {
  SESSION_COOKIE_NAME,
  buildSessionClaims,
  signSessionClaims,
} from "../src/lib/sessionCookies";
import { POST as caddiesPOST } from "../src/app/api/caddies/route";
import { PATCH as caddyPATCH } from "../src/app/api/caddies/[id]/route";
import { POST as previewPOST } from "../src/app/api/caddies/reassign/preview/route";
import { POST as applyPOST } from "../src/app/api/caddies/reassign/apply/route";
import { CADDY_REASSIGN_AUDIT_ACTION } from "../src/lib/caddyReassign";
import {
  findSlotHoldingConflicts,
  isSlotHoldingStatus,
} from "../src/lib/caddySlot";
import { occupiesHouseThirdSlot } from "../src/lib/caddyManage";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET ||
  process.env.NEXTAUTH_SECRET ||
  "reassign-v2-test-secret-32chars-min!!";

const TAG = "__REASSIGN_CONC__";
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

async function adminReq(url: string, body: unknown, method = "POST") {
  const token = await signSessionClaims(
    buildSessionClaims({
      userId: null,
      username: "admin",
      role: "admin",
      sessionVersion: 0,
    })
  );
  return new NextRequest(url, {
    method,
    headers: {
      cookie: `${SESSION_COOKIE_NAME}=${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function jsonStatus(res: Response) {
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

function holdersOnSlot(
  rows: Array<{
    team: string;
    teamOrder: number;
    employmentStatus: string;
    caddyType: string | null;
    name: string;
    id: number;
  }>,
  team: string,
  teamOrder: number
) {
  return rows.filter(
    (row) =>
      row.team === team &&
      row.teamOrder === teamOrder &&
      occupiesHouseThirdSlot(row) &&
      isSlotHoldingStatus(row.employmentStatus)
  );
}

async function occupancy(team: string, teamOrder: number) {
  const rows = await prisma.caddy.findMany({
    where: { team },
    select: {
      id: true,
      name: true,
      team: true,
      teamOrder: true,
      employmentStatus: true,
      caddyType: true,
    },
  });
  const people = holdersOnSlot(rows, team, teamOrder);
  const conflicts = findSlotHoldingConflicts(
    rows.map((row) => ({
      id: row.id,
      name: row.name,
      team: row.team,
      teamOrder: row.teamOrder,
      emp: String(row.employmentStatus),
      caddyType: row.caddyType,
    }))
  );
  return { people, conflicts, rows };
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
  await prisma.user.deleteMany({ where: { caddyId: { in: ids } } });
  await prisma.cart.deleteMany({ where: { ownerCaddyId: { in: ids } } });
  await prisma.marshalProfile.deleteMany({ where: { caddyId: { in: ids } } });
  await prisma.caddy.deleteMany({ where: { id: { in: ids } } });
}

async function createTagged(name: string, team: string, teamOrder: number) {
  return prisma.caddy.create({
    data: {
      name: `${TAG}${name}`,
      team,
      teamOrder,
      employmentStatus: "ACTIVE",
      caddyType: team.startsWith("9") ? "THIRD" : "HOUSE",
    },
  });
}

async function main() {
  assertLocalDatabaseUrl(process.env.DATABASE_URL);
  await cleanup();

  try {
    const team = "8조";
    const slotA = 20;
    const slotB = 21;
    const slotC = 22;
    const before = await occupancy(team, slotA);
    assert(
      holdersOnSlot(before.rows, team, slotA).length === 0 &&
        holdersOnSlot(before.rows, team, slotB).length === 0 &&
        holdersOnSlot(before.rows, team, slotC).length === 0,
      `${team} ${slotA}-${slotC} start empty`
    );

    const mover = await createTagged("MOVER", team, slotA);
    const other = await createTagged("OTHER", team, slotB);
    const assignment = await prisma.assignment.create({
      data: {
        caddyId: mover.id,
        type: "OFF",
        startDate: new Date("2099-03-01T00:00:00.000Z"),
        endDate: new Date("2099-03-02T00:00:00.000Z"),
        comment: `${TAG}off`,
      },
    });
    const user = await prisma.user.create({
      data: {
        username: `${TAG}user`,
        password: "x",
        role: "caddy",
        caddyId: mover.id,
      },
    });

    section("Preview 이후 동일 조 신규 등록 → Apply 409");
    const previewMove = {
      placements: [{ id: mover.id, team, teamOrder: slotC }],
      mode: "explicit" as const,
    };
    const preview = await jsonStatus(
      await previewPOST(await adminReq("http://local/preview", previewMove))
    );
    assert(preview.status === 200 && preview.body?.ok === true, "preview ok");
    const createdAfterPreview = await jsonStatus(
      await caddiesPOST(
        await adminReq("http://local/api/caddies", {
          name: `${TAG}AFTERPREVIEW`,
          team,
          teamOrder: slotC,
        })
      )
    );
    assert(createdAfterPreview.status === 200, "POST into preview dest succeeds first");
    const staleApply = await jsonStatus(
      await applyPOST(
        await adminReq("http://local/apply", {
          ...previewMove,
          base: preview.body.base,
        })
      )
    );
    assert(
      staleApply.status === 409 &&
        (staleApply.body?.code === "stale_roster" ||
          staleApply.body?.code === "slot_conflict"),
      "apply after insert returns 409"
    );
    const afterStale = await occupancy(team, slotC);
    assert(afterStale.people.length === 1, "dest has exactly one occupant");
    assert(
      afterStale.people[0].id === createdAfterPreview.body.id,
      "POST winner kept the slot; reassign rolled back"
    );
    const moverUnmoved = await prisma.caddy.findUniqueOrThrow({
      where: { id: mover.id },
    });
    assert(moverUnmoved.teamOrder === slotA, "mover not partially updated");

    await prisma.caddy.delete({ where: { id: createdAfterPreview.body.id } });

    section("신규 등록 vs 재배치 동시 경합");
    const preview2 = await jsonStatus(
      await previewPOST(
        await adminReq("http://local/preview", {
          placements: [{ id: mover.id, team, teamOrder: slotC }],
        })
      )
    );
    const [postRace, applyRace] = await Promise.all([
      caddiesPOST(
        await adminReq("http://local/api/caddies", {
          name: `${TAG}RACEPOST`,
          team,
          teamOrder: slotC,
        })
      ).then(jsonStatus),
      applyPOST(
        await adminReq("http://local/apply", {
          placements: [{ id: mover.id, team, teamOrder: slotC }],
          base: preview2.body.base,
        })
      ).then(jsonStatus),
    ]);
    const winners = [postRace, applyRace].filter((r) => r.status === 200);
    const losers = [postRace, applyRace].filter((r) => r.status >= 400);
    assert(winners.length === 1, "exactly one of POST/apply succeeded");
    assert(
      losers.length === 1 && losers[0].status === 409,
      "loser is 409 not 200"
    );
    const raceOcc = await occupancy(team, slotC);
    assert(raceOcc.people.length === 1, "no duplicate occupancy after POST race");
    assert(raceOcc.conflicts.length === 0, "no team slot conflicts");
    const moverAfterRace = await prisma.caddy.findUniqueOrThrow({
      where: { id: mover.id },
    });
    assert(moverAfterRace.id === mover.id, "mover id preserved");
    if (postRace.status === 200) {
      await prisma.caddy.delete({ where: { id: postRace.body.id } });
      await prisma.caddy.update({
        where: { id: mover.id },
        data: { team, teamOrder: slotA },
      });
    } else {
      await prisma.caddy.update({
        where: { id: mover.id },
        data: { team, teamOrder: slotA },
      });
    }

    section("단건 PATCH vs 재배치 동시 경합");
    await prisma.caddy.update({
      where: { id: other.id },
      data: { team, teamOrder: slotB },
    });
    await prisma.caddy.update({
      where: { id: mover.id },
      data: { team, teamOrder: slotA },
    });
    const previewPatch = await jsonStatus(
      await previewPOST(
        await adminReq("http://local/preview", {
          placements: [{ id: mover.id, team, teamOrder: slotC }],
        })
      )
    );
    const [patchRace, applyPatchRace] = await Promise.all([
      caddyPATCH(await adminReq("http://local/api/caddies/" + other.id, {
        team,
        teamOrder: slotC,
      }, "PATCH"), { params: { id: String(other.id) } }).then(jsonStatus),
      applyPOST(
        await adminReq("http://local/apply", {
          placements: [{ id: mover.id, team, teamOrder: slotC }],
          base: previewPatch.body.base,
        })
      ).then(jsonStatus),
    ]);
    const patchWinners = [patchRace, applyPatchRace].filter((r) => r.status === 200);
    const patchLosers = [patchRace, applyPatchRace].filter((r) => r.status >= 400);
    assert(patchWinners.length === 1, "exactly one of PATCH/apply succeeded");
    assert(patchLosers.length === 1 && patchLosers[0].status === 409, "PATCH race loser 409");
    const patchOcc = await occupancy(team, slotC);
    assert(patchOcc.people.length === 1, "no duplicate occupancy after PATCH race");
    await prisma.caddy.update({
      where: { id: mover.id },
      data: { team, teamOrder: slotA },
    });
    await prisma.caddy.update({
      where: { id: other.id },
      data: { team, teamOrder: slotB },
    });

    section("재배치 2건 동시 실행");
    const previewA = await jsonStatus(
      await previewPOST(
        await adminReq("http://local/preview", {
          placements: [{ id: mover.id, team, teamOrder: slotC }],
        })
      )
    );
    const previewB = await jsonStatus(
      await previewPOST(
        await adminReq("http://local/preview", {
          placements: [{ id: other.id, team, teamOrder: slotC }],
        })
      )
    );
    const [applyA, applyB] = await Promise.all([
      applyPOST(
        await adminReq("http://local/applyA", {
          placements: [{ id: mover.id, team, teamOrder: slotC }],
          base: previewA.body.base,
        })
      ).then(jsonStatus),
      applyPOST(
        await adminReq("http://local/applyB", {
          placements: [{ id: other.id, team, teamOrder: slotC }],
          base: previewB.body.base,
        })
      ).then(jsonStatus),
    ]);
    const applyWinners = [applyA, applyB].filter((r) => r.status === 200);
    const applyLosers = [applyA, applyB].filter((r) => r.status >= 400);
    assert(applyWinners.length === 1, "one reassign committed");
    assert(applyLosers.length === 1 && applyLosers[0].status === 409, "other reassign 409");
    const dualOcc = await occupancy(team, slotC);
    assert(dualOcc.people.length === 1, "two applies did not double-book");

    section("실패 시 부분 저장 없음 / 연관 데이터 보존");
    const relatedAssignment = await prisma.assignment.findUniqueOrThrow({
      where: { id: assignment.id },
    });
    const relatedUser = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    assert(relatedAssignment.caddyId === mover.id, "assignment still on same caddy id");
    assert(relatedUser.caddyId === mover.id, "user.caddyId unchanged");
    const finalConflicts = (await occupancy(team, slotC)).conflicts;
    assert(finalConflicts.length === 0, "team has no numbered slot duplicates");
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
