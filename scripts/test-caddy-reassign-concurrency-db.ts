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
import { POST as importApplyPOST } from "../src/app/api/caddies/import/apply/route";
import {
  applyRosterImportPayloadV2,
  RosterImportApplyError,
} from "../lib/caddyRosterImportV2";
import { lockCaddyTableForSlotMutation } from "../src/lib/caddySlotLock";
import { DRIVING_POOL_TEAM } from "../src/lib/caddyManage";
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
    const slotD = 23;
    const before = await occupancy(team, slotA);
    assert(
      holdersOnSlot(before.rows, team, slotA).length === 0 &&
        holdersOnSlot(before.rows, team, slotB).length === 0 &&
        holdersOnSlot(before.rows, team, slotC).length === 0 &&
        holdersOnSlot(before.rows, team, slotD).length === 0,
      `${team} ${slotA}-${slotD} start empty`
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

    await prisma.caddy.update({
      where: { id: mover.id },
      data: { team, teamOrder: slotA, caddyType: "HOUSE", employmentStatus: "ACTIVE" },
    });
    await prisma.caddy.update({
      where: { id: other.id },
      data: { team, teamOrder: slotB, caddyType: "HOUSE", employmentStatus: "ACTIVE" },
    });

    section("Import Apply vs 재배치 동시 경합");
    const previewImport = await jsonStatus(
      await previewPOST(
        await adminReq("http://local/preview", {
          placements: [{ id: mover.id, team, teamOrder: slotC }],
        })
      )
    );
    const [importRace, applyImportRace] = await Promise.all([
      importApplyPOST(
        await adminReq("http://local/api/caddies/import/apply", {
          applyPayload: {
            updates: [],
            creates: [
              {
                name: `${TAG}IMPORT`,
                team,
                teamOrder: slotC,
                employmentStatus: "ACTIVE",
              },
            ],
          },
        })
      ).then(jsonStatus),
      applyPOST(
        await adminReq("http://local/applyImport", {
          placements: [{ id: mover.id, team, teamOrder: slotC }],
          base: previewImport.body.base,
        })
      ).then(jsonStatus),
    ]);
    const importWinners = [importRace, applyImportRace].filter((r) => r.status === 200);
    const importLosers = [importRace, applyImportRace].filter((r) => r.status >= 400);
    assert(importWinners.length === 1, "exactly one of import/apply succeeded");
    assert(
      importLosers.length === 1 && importLosers[0].status === 409,
      "import race loser is 409 not 500"
    );
    const importOcc = await occupancy(team, slotC);
    assert(importOcc.people.length === 1, "no duplicate occupancy after import race");
    assert(importOcc.conflicts.length === 0, "no team slot conflicts after import race");
    const imported = await prisma.caddy.findMany({
      where: { name: `${TAG}IMPORT` },
      select: { id: true },
    });
    if (imported.length > 0) {
      await prisma.caddy.deleteMany({
        where: { id: { in: imported.map((row) => row.id) } },
      });
    }
    await prisma.caddy.update({
      where: { id: mover.id },
      data: { team, teamOrder: slotA, employmentStatus: "ACTIVE" },
    });

    section("Import employment-only restore vs same-slot POST");
    const empTeam = "7조";
    const emptyHigh: number[] = [];
    for (const n of [20, 21, 22, 23, 24]) {
      const occ = await occupancy(empTeam, n);
      if (holdersOnSlot(occ.rows, empTeam, n).length === 0) emptyHigh.push(n);
    }
    assert(
      emptyHigh.length >= 2,
      `${empTeam} has two empty high slots for employment restore tests`
    );
    const empSlot = emptyHigh[0];
    const leaveSlot = emptyHigh[1];
    const empStart = await occupancy(empTeam, empSlot);
    assert(
      holdersOnSlot(empStart.rows, empTeam, empSlot).length === 0,
      `${empTeam} ${empSlot} start empty`
    );
    const restoreA = await createTagged("RESTOREA", empTeam, empSlot);
    await prisma.caddy.update({
      where: { id: restoreA.id },
      data: { employmentStatus: "RETIRED" },
    });
    const staleExisting = await prisma.caddy.findMany({
      select: {
        id: true,
        name: true,
        team: true,
        teamOrder: true,
        employmentStatus: true,
        phoneNormalized: true,
        thirdBandSubgroup: true,
        caddyType: true,
      },
    });
    const postedB = await jsonStatus(
      await caddiesPOST(
        await adminReq("http://local/api/caddies", {
          name: `${TAG}RESTOREB`,
          team: empTeam,
          teamOrder: empSlot,
        })
      )
    );
    assert(postedB.status === 200, "POST into retired slot succeeds after preview snapshot");
    try {
      await applyRosterImportPayloadV2(
        { updates: [{ id: restoreA.id, employmentStatus: "ACTIVE" }], creates: [] },
        prisma,
        {
          existingForGuard: staleExisting.map((row) => ({
            ...row,
            employmentStatus: String(row.employmentStatus),
          })),
        }
      );
      assert(false, "retired→ACTIVE import onto occupied slot should throw");
    } catch (e) {
      assert(
        e instanceof RosterImportApplyError &&
          e.status === 409 &&
          e.code === "stale_roster",
        "employment-only restore is 409 stale_roster"
      );
    }
    const restoreAfter = await prisma.caddy.findUniqueOrThrow({
      where: { id: restoreA.id },
    });
    const restoreOcc = await occupancy(empTeam, empSlot);
    assert(
      restoreAfter.employmentStatus === "RETIRED",
      "import employment restore rolled back"
    );
    assert(
      restoreOcc.people.length === 1 && restoreOcc.people[0].id === postedB.body.id,
      "exactly one ACTIVE holder after retired restore race"
    );
    assert(
      holdersOnSlot(restoreOcc.rows, empTeam, empSlot).length === 1,
      "no numbered slot duplicates after restore race"
    );

    const leaveStart = await occupancy(empTeam, leaveSlot);
    assert(
      holdersOnSlot(leaveStart.rows, empTeam, leaveSlot).length === 0,
      `${empTeam} ${leaveSlot} start empty`
    );
    const leaveA = await createTagged("LEAVEA", empTeam, leaveSlot);
    await prisma.caddy.update({
      where: { id: leaveA.id },
      data: { employmentStatus: "LEAVE" },
    });
    const leaveGuard = await prisma.caddy.findMany({
      select: {
        id: true,
        name: true,
        team: true,
        teamOrder: true,
        employmentStatus: true,
        phoneNormalized: true,
        thirdBandSubgroup: true,
        caddyType: true,
      },
    });
    const leaveOk = await applyRosterImportPayloadV2(
      { updates: [{ id: leaveA.id, employmentStatus: "ACTIVE" }], creates: [] },
      prisma,
      {
        existingForGuard: leaveGuard.map((row) => ({
          ...row,
          employmentStatus: String(row.employmentStatus),
        })),
      }
    );
    assert(leaveOk.updated === 1, "LEAVE→ACTIVE apply commits when slot is exclusive");
    const leaveAfterOk = await prisma.caddy.findUniqueOrThrow({
      where: { id: leaveA.id },
    });
    assert(leaveAfterOk.employmentStatus === "ACTIVE", "LEAVE→ACTIVE persisted");

    await prisma.caddy.update({
      where: { id: leaveA.id },
      data: { employmentStatus: "LEAVE" },
    });
    const leaveGuard2 = await prisma.caddy.findMany({
      select: {
        id: true,
        name: true,
        team: true,
        teamOrder: true,
        employmentStatus: true,
        phoneNormalized: true,
        thirdBandSubgroup: true,
        caddyType: true,
      },
    });
    const extraLeave = await prisma.caddy.create({
      data: {
        name: `${TAG}LEAVEEXTRA`,
        team: empTeam,
        teamOrder: leaveSlot,
        employmentStatus: "ACTIVE",
        caddyType: "HOUSE",
      },
    });
    try {
      await applyRosterImportPayloadV2(
        { updates: [{ id: leaveA.id, employmentStatus: "ACTIVE" }], creates: [] },
        prisma,
        {
          existingForGuard: leaveGuard2.map((row) => ({
            ...row,
            employmentStatus: String(row.employmentStatus),
          })),
        }
      );
      assert(false, "LEAVE→ACTIVE onto extra occupant should throw");
    } catch (e) {
      assert(
        e instanceof RosterImportApplyError &&
          e.status === 409 &&
          e.code === "stale_roster",
        "LEAVE/ACTIVE-only dest occupancy is 409"
      );
    }
    const leaveAfterConflict = await prisma.caddy.findUniqueOrThrow({
      where: { id: leaveA.id },
    });
    assert(
      leaveAfterConflict.employmentStatus === "LEAVE",
      "LEAVE→ACTIVE conflict rolled back"
    );
    const leaveConflictOcc = await occupancy(empTeam, leaveSlot);
    assert(
      leaveConflictOcc.people.filter((p) => p.employmentStatus === "ACTIVE").length === 1,
      "LEAVE/ACTIVE conflict left a single ACTIVE occupant"
    );

    const [empImportRace, empPostRace] = await Promise.all([
      applyRosterImportPayloadV2(
        { updates: [{ id: restoreA.id, employmentStatus: "ACTIVE" }], creates: [] },
        prisma,
        {
          existingForGuard: staleExisting.map((row) => ({
            ...row,
            employmentStatus: String(row.employmentStatus),
          })),
        }
      )
        .then((body) => ({ status: 200 as const, body }))
        .catch((e) => ({
          status: e instanceof RosterImportApplyError ? e.status : 500,
          body: e instanceof RosterImportApplyError ? { code: e.code } : null,
        })),
      jsonStatus(
        await caddiesPOST(
          await adminReq("http://local/api/caddies", {
            name: `${TAG}RESTORECONC`,
            team: empTeam,
            teamOrder: empSlot,
          })
        )
      ),
    ]);
    const empRacePair = [empImportRace, empPostRace];
    assert(
      empRacePair.every((r) => r.status === 200 || r.status === 409),
      "concurrent restore/POST is 200 or 409, not 500"
    );
    const concOcc = await occupancy(empTeam, empSlot);
    assert(concOcc.people.length === 1, "concurrent restore/POST did not double-book");
    assert(
      holdersOnSlot(concOcc.rows, empTeam, empSlot).length === 1,
      "no duplicates after concurrent restore/POST"
    );

    await prisma.caddy.deleteMany({
      where: {
        id: {
          in: [
            restoreA.id,
            postedB.body.id,
            leaveA.id,
            extraLeave.id,
            ...(empPostRace.status === 200 && empPostRace.body?.id
              ? [empPostRace.body.id]
              : []),
          ].filter(Boolean),
        },
      },
    });
    const concCreated = await prisma.caddy.findMany({
      where: { name: { startsWith: `${TAG}RESTORE` } },
      select: { id: true },
    });
    if (concCreated.length > 0) {
      await prisma.caddy.deleteMany({
        where: { id: { in: concCreated.map((row) => row.id) } },
      });
    }

    section("재직/휴직 변경 vs 재배치 동시 경합");
    const retired = await createTagged("RETIRED22", team, slotC);
    await prisma.caddy.update({
      where: { id: retired.id },
      data: { employmentStatus: "RETIRED" },
    });
    const previewEmp = await jsonStatus(
      await previewPOST(
        await adminReq("http://local/previewEmp", {
          placements: [{ id: mover.id, team, teamOrder: slotC }],
        })
      )
    );
    const [empRace, applyEmpRace] = await Promise.all([
      caddyPATCH(
        await adminReq(
          "http://local/api/caddies/" + retired.id,
          { employmentStatus: "ACTIVE" },
          "PATCH"
        ),
        { params: { id: String(retired.id) } }
      ).then(jsonStatus),
      applyPOST(
        await adminReq("http://local/applyEmp", {
          placements: [{ id: mover.id, team, teamOrder: slotC }],
          base: previewEmp.body.base,
        })
      ).then(jsonStatus),
    ]);
    const empWinners = [empRace, applyEmpRace].filter((r) => r.status === 200);
    const empLosers = [empRace, applyEmpRace].filter((r) => r.status >= 400);
    assert(empWinners.length === 1, "exactly one of employment/apply succeeded");
    assert(empLosers.length === 1 && empLosers[0].status === 409, "employment race loser 409");
    const empOcc = await occupancy(team, slotC);
    assert(empOcc.people.length === 1, "no duplicate occupancy after employment race");
    await prisma.caddy.delete({ where: { id: retired.id } });
    await prisma.caddy.update({
      where: { id: mover.id },
      data: { team, teamOrder: slotA, employmentStatus: "ACTIVE" },
    });

    section("드라이빙 전환 vs 재배치 동시 경합");
    await prisma.caddy.update({
      where: { id: other.id },
      data: { team, teamOrder: slotB, caddyType: "HOUSE", employmentStatus: "ACTIVE" },
    });
    const previewDrive = await jsonStatus(
      await previewPOST(
        await adminReq("http://local/previewDrive", {
          placements: [{ id: mover.id, team, teamOrder: slotB }],
        })
      )
    );
    const [driveRace, applyDriveRace] = await Promise.all([
      caddyPATCH(
        await adminReq(
          "http://local/api/caddies/" + other.id,
          { caddyType: "DRIVING" },
          "PATCH"
        ),
        { params: { id: String(other.id) } }
      ).then(jsonStatus),
      applyPOST(
        await adminReq("http://local/applyDrive", {
          placements: [{ id: mover.id, team, teamOrder: slotB }],
          base: previewDrive.body.base,
        })
      ).then(jsonStatus),
    ]);
    assert(
      [driveRace, applyDriveRace].every((r) => r.status === 200 || r.status === 409),
      "driving race is 200 or 409, not 500"
    );
    const driveOcc = await occupancy(team, slotB);
    assert(driveOcc.people.length <= 1, "no duplicate occupancy after driving race");
    assert(driveOcc.conflicts.length === 0, "no team slot conflicts after driving race");
    const otherAfterDrive = await prisma.caddy.findUniqueOrThrow({
      where: { id: other.id },
    });
    const moverAfterDrive = await prisma.caddy.findUniqueOrThrow({
      where: { id: mover.id },
    });
    if (driveRace.status === 200 && applyDriveRace.status === 200) {
      assert(
        otherAfterDrive.team === DRIVING_POOL_TEAM &&
          moverAfterDrive.teamOrder === slotB,
        "serialized vacate-then-take kept a single occupant"
      );
    }
    if (driveRace.status === 200) {
      assert(otherAfterDrive.caddyType === "DRIVING", "driving PATCH persisted");
    }
    await prisma.caddy.update({
      where: { id: mover.id },
      data: { team, teamOrder: slotA, caddyType: "HOUSE", employmentStatus: "ACTIVE" },
    });
    await prisma.caddy.update({
      where: { id: other.id },
      data: {
        team,
        teamOrder: slotB,
        caddyType: "HOUSE",
        employmentStatus: "ACTIVE",
      },
    });

    section("기존 단건 PATCH 동시 수정");
    const [patchOne, patchTwo] = await Promise.all([
      caddyPATCH(
        await adminReq(
          "http://local/api/caddies/" + mover.id,
          { team, teamOrder: slotC },
          "PATCH"
        ),
        { params: { id: String(mover.id) } }
      ).then(jsonStatus),
      caddyPATCH(
        await adminReq(
          "http://local/api/caddies/" + mover.id,
          { team, teamOrder: slotD },
          "PATCH"
        ),
        { params: { id: String(mover.id) } }
      ).then(jsonStatus),
    ]);
    const patchSameWinners = [patchOne, patchTwo].filter((r) => r.status === 200);
    const patchSameLosers = [patchOne, patchTwo].filter((r) => r.status >= 400);
    assert(patchSameWinners.length === 1, "exactly one concurrent PATCH committed");
    assert(
      patchSameLosers.length === 1 &&
        patchSameLosers[0].status === 409 &&
        (patchSameLosers[0].body?.code === "stale_roster" ||
          patchSameLosers[0].body?.code === "slot_occupied"),
      "other PATCH is 409 stale/occupied"
    );
    const patchSameOccC = await occupancy(team, slotC);
    const patchSameOccD = await occupancy(team, slotD);
    assert(
      patchSameOccC.people.length + patchSameOccD.people.length === 1,
      "concurrent PATCH did not double-book dest slots"
    );
    await prisma.caddy.update({
      where: { id: mover.id },
      data: { team, teamOrder: slotA },
    });

    section("잠금 대기 후 기존 PATCH는 500 없이 완료");
    const lockWaitStarted = Date.now();
    const blocker = prisma.$transaction(
      async (tx) => {
        await lockCaddyTableForSlotMutation(tx);
        await new Promise((resolve) => setTimeout(resolve, 400));
      },
      { timeout: 10_000, maxWait: 5_000 }
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const waitedPatch = await jsonStatus(
      await caddyPATCH(
        await adminReq(
          "http://local/api/caddies/" + other.id,
          { employmentStatus: "LEAVE" },
          "PATCH"
        ),
        { params: { id: String(other.id) } }
      )
    );
    await blocker;
    const lockWaitMs = Date.now() - lockWaitStarted;
    assert(waitedPatch.status === 200, "lock wait PATCH succeeds without 500");
    assert(
      waitedPatch.body?.employmentStatus === "LEAVE",
      "lock wait PATCH applied employment"
    );
    assert(lockWaitMs >= 300, "PATCH waited for the table lock");
    assert(lockWaitMs < 8_000, "lock wait did not hit the 20s transaction timeout");
    await prisma.caddy.update({
      where: { id: other.id },
      data: { employmentStatus: "ACTIVE" },
    });

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
