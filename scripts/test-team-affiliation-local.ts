/**
 * Local caddy_local only: migrate + affiliation save/query + engine integration.
 * Production/Preview/Neon writes forbidden. Operational roster is not mutated.
 *
 *   npm run test:team-affiliation-local
 */
import { spawnSync } from "node:child_process";
import {
  assertLocalFixtureDatabase,
  isProductionDatabaseUrl,
  parseDatabaseUrl,
} from "../src/lib/dbSafety";

const url = assertLocalFixtureDatabase(process.env.DATABASE_URL);
{
  const parsed = parseDatabaseUrl(url);
  const db = decodeURIComponent(parsed.pathname.replace(/^\//, "")).split("?")[0];
  if (isProductionDatabaseUrl(url)) {
    throw new Error("⛔ Neon/production DATABASE_URL. local 검증 중단.");
  }
  if (!["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) {
    throw new Error(`⛔ host=${parsed.hostname} 는 localhost 가 아님. 중단.`);
  }
  if (db !== "caddy_local") {
    throw new Error(`⛔ db=${db} 는 caddy_local 이 아님. 중단.`);
  }
  console.log(
    `DB target host=${parsed.hostname} port=${parsed.port || 5432} db=${db} user=${parsed.username}`
  );
}

import { prisma } from "../src/lib/prisma";
import {
  computeAutoAssignmentsV1,
  reservationKey,
  splitCaddyPools,
  ThirdStartCaddyError,
  type AutoAssignCaddy,
  type AutoAssignReservation,
} from "../src/lib/autoAssignEngine";
import {
  previewLiveAssignmentChange,
  previewLiveAssignmentEvents,
} from "../src/lib/assignmentChange";
import {
  autoResultFromDraft,
  createDraftFromAutoResult,
} from "../src/lib/assignmentDraft";
import {
  assignmentDraftToPayload,
  parseDailyBoardDraftPayload,
  payloadToAssignmentDraft,
} from "../src/lib/dailyBoardDraft";
import { computeAvailability } from "../src/lib/availabilityEngine";
import {
  DEFAULT_TEAM_AFFILIATION_SNAPSHOT,
  TEAM_AFFILIATION_CHANGED_CODE,
  TEAM_AFFILIATION_TEAMS,
  houseTenThirdOffSnapshot,
  houseTeamsInSnapshot,
  inactiveTeamsInSnapshot,
  sameTeamAffiliationRules,
  thirdTeamsInSnapshot,
  type TeamAffiliationRow,
} from "../src/lib/teamAffiliation";
import {
  loadTeamAffiliationSnapshot,
  listTeamAffiliationVersions,
  saveTeamAffiliationVersion,
} from "../src/lib/teamAffiliationService";

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

function houseTenTeams(): TeamAffiliationRow[] {
  return TEAM_AFFILIATION_TEAMS.map((team) => {
    const n = Number(team.replace("조", ""));
    return {
      team,
      affiliation: "HOUSE" as const,
      operational: n <= 10,
    };
  });
}

function thirdReturnTeams(): TeamAffiliationRow[] {
  return TEAM_AFFILIATION_TEAMS.map((team) => {
    const n = Number(team.replace("조", ""));
    return {
      team,
      affiliation: n >= 9 ? ("THIRD" as const) : ("HOUSE" as const),
      operational: true,
    };
  });
}

function testCaddy(
  id: number,
  team: string,
  teamOrder: number,
  extra?: Partial<AutoAssignCaddy>
): AutoAssignCaddy {
  return {
    id,
    name: extra?.name || `PR379-${team}-${teamOrder}`,
    team,
    teamOrder,
    caddyType: extra?.caddyType,
    employmentStatus: extra?.employmentStatus ?? "ACTIVE",
    thirdBandSubgroup: extra?.thirdBandSubgroup ?? null,
    extraFlags: extra?.extraFlags,
  };
}

function testReservations(
  date: string,
  specs: Array<{ shift: "1부" | "2부" | "3부"; count: number }>
): AutoAssignReservation[] {
  const out: AutoAssignReservation[] = [];
  let row = 2;
  for (const spec of specs) {
    for (let i = 0; i < spec.count; i++) {
      const total = 6 * 60 + i * 8;
      const h = String(Math.floor(total / 60)).padStart(2, "0");
      const m = String(total % 60).padStart(2, "0");
      out.push({
        date,
        course: "VERTHILL",
        courseLabel: "베르힐",
        shift: spec.shift,
        teeTime: `${h}:${m}`,
        teamName: `PR379-${spec.shift}-${i + 1}`,
        rawRowIndex: row++,
      });
    }
  }
  return out;
}

function twoShiftPool(): AutoAssignCaddy[] {
  return [
    testCaddy(101, "1조", 1, { caddyType: "HOUSE", name: "PR379-1조" }),
    testCaddy(201, "2조", 1, { caddyType: "HOUSE", name: "PR379-2조" }),
    testCaddy(901, "9조", 1, { caddyType: "THIRD", name: "PR379-9조" }),
    testCaddy(902, "9조", 2, {
      caddyType: "THIRD",
      employmentStatus: "LEAVE",
      name: "PR379-9조-휴직",
    }),
    testCaddy(1001, "10조", 1, { caddyType: "THIRD", name: "PR379-10조" }),
    testCaddy(1002, "10조", 2, {
      caddyType: "THIRD",
      employmentStatus: "RETIRED",
      name: "PR379-10조-퇴사",
    }),
    testCaddy(1101, "11조", 1, { caddyType: "THIRD", name: "PR379-11조" }),
    testCaddy(1201, "12조", 1, { caddyType: "THIRD", name: "PR379-12조" }),
    testCaddy(801, "드라이빙", 0, { caddyType: "DRIVING", name: "PR379-드라이브" }),
  ];
}

async function caddyFingerprint() {
  const rows = await prisma.caddy.findMany({
    select: {
      id: true,
      team: true,
      teamOrder: true,
      caddyType: true,
      employmentStatus: true,
    },
    orderBy: { id: "asc" },
  });
  return rows
    .map(
      (row) =>
        `${row.id}|${row.team}|${row.teamOrder}|${row.caddyType}|${row.employmentStatus}`
    )
    .join("\n");
}

async function publishedFingerprint() {
  const rows = await prisma.dailyBoardPublished.findMany({
    select: {
      date: true,
      schemaVersion: true,
      sourceDraftVersion: true,
      publishedAt: true,
    },
    orderBy: { date: "asc" },
  });
  return rows
    .map(
      (row) =>
        `${row.date.toISOString()}|${row.schemaVersion}|${row.sourceDraftVersion}|${row.publishedAt.toISOString()}`
    )
    .join("\n");
}

function migrateLocal() {
  section("local migrate deploy");
  const ran = spawnSync("npx", ["prisma", "migrate", "deploy"], {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
  });
  const out = `${ran.stdout || ""}\n${ran.stderr || ""}`;
  if (ran.status !== 0) {
    console.error(out);
    throw new Error("prisma migrate deploy failed on local DB");
  }
  assert(
    /team_affiliation_settings|No pending migrations/i.test(out),
    "affiliation migration applied or already present"
  );
  console.log(
    out
      .split("\n")
      .filter((line) => /migration|Applied|already/i.test(line))
      .slice(0, 12)
      .join("\n")
  );
}

async function main() {
  migrateLocal();

  section("테이블 존재");
  const tables = await prisma.$queryRaw<Array<{ relname: string }>>`
    SELECT relname
    FROM pg_class
    WHERE relname IN ('TeamAffiliationVersion', 'TeamAffiliationItem')
      AND relkind = 'r'
  `;
  assert(
    tables.some((row) => row.relname === "TeamAffiliationVersion") &&
      tables.some((row) => row.relname === "TeamAffiliationItem"),
    "TeamAffiliationVersion/Item 테이블 존재"
  );

  const caddiesBefore = await caddyFingerprint();
  const publishedBefore = await publishedFingerprint();
  const caddyCount = caddiesBefore ? caddiesBefore.split("\n").length : 0;
  const publishedCount = publishedBefore
    ? publishedBefore.split("\n").length
    : 0;
  console.log(`existing caddies=${caddyCount} publishedBoards=${publishedCount}`);

  section("저장/조회: default → 2026-11-16 → 2027-03-01");
  await saveTeamAffiliationVersion({
    body: {
      effectiveFrom: "2026-11-16",
      note: "PR379-LOCAL-VERIFY house 1-10",
      teams: houseTenTeams(),
    },
  });
  await saveTeamAffiliationVersion({
    body: {
      effectiveFrom: "2027-03-01",
      note: "PR379-LOCAL-VERIFY third return",
      teams: thirdReturnTeams(),
    },
  });

  const nov15 = await loadTeamAffiliationSnapshot("2026-11-15");
  const nov16 = await loadTeamAffiliationSnapshot("2026-11-16");
  const today = await loadTeamAffiliationSnapshot("2026-11-18");
  const futureNow = await loadTeamAffiliationSnapshot("2026-12-01");
  const mar2027 = await loadTeamAffiliationSnapshot("2027-03-01");
  const versions = await listTeamAffiliationVersions();

  assert(
    houseTeamsInSnapshot(nov15).join(",") ===
      "1조,2조,3조,4조,5조,6조,7조,8조" &&
      thirdTeamsInSnapshot(nov15).join(",") === "9조,10조,11조,12조" &&
      inactiveTeamsInSnapshot(nov15).length === 0,
    "11/15 = 1~8 HOUSE / 9~12 THIRD"
  );
  assert(
    houseTeamsInSnapshot(nov16).join(",") ===
      "1조,2조,3조,4조,5조,6조,7조,8조,9조,10조" &&
      inactiveTeamsInSnapshot(nov16).join(",") === "11조,12조",
    "11/16 = 1~10 HOUSE, 11~12 미운영"
  );
  assert(
    sameTeamAffiliationRules(today, nov16) &&
      sameTeamAffiliationRules(futureNow, nov16),
    "현재·연말 날짜는 11/16 설정을 따름"
  );
  assert(
    thirdTeamsInSnapshot(mar2027).join(",") === "9조,10조,11조,12조" &&
      inactiveTeamsInSnapshot(mar2027).length === 0,
    "2027-03-01 3부반 복귀"
  );
  assert(
    !sameTeamAffiliationRules(nov16, mar2027),
    "미래 2027 설정이 2026-11-18 소속을 바꾸지 않음"
  );
  assert(
    versions.some((row) => row.effectiveFrom === "2026-11-16") &&
      versions.some((row) => row.effectiveFrom === "2027-03-01"),
    "버전 목록에 11/16·2027-03-01"
  );

  const caddiesAfter = await caddyFingerprint();
  const publishedAfter = await publishedFingerprint();
  assert(caddiesAfter === caddiesBefore, "캐디 명단 row 보존");
  assert(publishedAfter === publishedBefore, "확정 배치표 보존");

  const dbSnap = await loadTeamAffiliationSnapshot("2026-11-16");
  const pool = twoShiftPool();

  section("가용: 미운영 조 제외");
  const avail = computeAvailability({
    date: "2026-11-16",
    caddies: pool.map((c) => ({
      id: c.id,
      name: c.name,
      team: c.team,
      teamOrder: c.teamOrder,
      employmentStatus: String(c.employmentStatus),
      caddyType: c.caddyType,
      extraFlags: c.extraFlags ?? [],
      thirdBandSubgroup: c.thirdBandSubgroup ?? null,
    })),
    teamAffiliation: dbSnap,
  });
  assert(
    avail.excluded.some(
      (row) => row.id === 1101 && row.excludedReasons.includes("미운영 조")
    ) &&
      avail.excluded.some(
        (row) => row.id === 1201 && row.excludedReasons.includes("미운영 조")
      ),
    "11·12조 미운영 가용 제외"
  );
  assert(
    avail.excluded.some((row) => row.id === 902) &&
      avail.excluded.some((row) => row.id === 1002),
    "휴직·퇴사 가용 제외"
  );

  section("2부제 자동배치 (DB 스냅샷)");
  const twoShift = computeAutoAssignmentsV1({
    date: "2026-11-16",
    available: pool,
    reservations: testReservations("2026-11-16", [
      { shift: "1부", count: 1 },
      { shift: "2부", count: 1 },
    ]),
    houseStartCaddyId: 901,
    teamAffiliation: dbSnap,
  });
  const s1 = twoShift.regularAssignments.filter((row) => row.shift === "1부");
  const s2 = twoShift.regularAssignments.filter((row) => row.shift === "2부");
  const assignedIds = twoShift.assignments.map((row) => row.caddy.id);
  assert(s1.length === 1 && s1[0]?.caddy.id === 901, "1부 첫 캐디 9조 HOUSE");
  assert(s2.length === 1 && s2[0]?.caddy.id === 1001, "2부 10조 HOUSE");
  assert(
    !assignedIds.includes(1101) && !assignedIds.includes(1201),
    "미운영 11·12조 배치 제외"
  );
  assert(
    !assignedIds.includes(902) && !assignedIds.includes(1002),
    "휴직·퇴사 배치 제외"
  );
  assert(
    !twoShift.assignments.some((row) => row.shift === "3부"),
    "3부 예약 없는 2부제"
  );
  assert(
    (twoShift.sparesByShift || []).some(
      (row) => row.shift === "1부" && (row.spare1 || row.spare2)
    ),
    "1부 스페어 계산"
  );
  const pools = splitCaddyPools(pool, dbSnap);
  assert(
    pools.house.some((c) => c.id === 901) &&
      pools.house.some((c) => c.id === 1001) &&
      !pools.house.some((c) => c.id === 1101),
    "HOUSE 풀에 9·10조, 미운영 11조 제외"
  );
  assert(pools.third.length === 0, "2부제 HOUSE 전환 후 THIRD 풀 없음");

  section("예약 이동·취소·병가 재배치");
  const moved = previewLiveAssignmentChange({
    previous: twoShift,
    regularCaddyPool: pool,
    change: {
      type: "MOVE_RESERVATION",
      reservationKey: reservationKey(s1[0].reservation),
      to: { course: "VERTHILL", shift: "2부", teeTime: "12:08" },
    },
    teamAffiliation: dbSnap,
  });
  assert(
    moved.after.assignments.some((row) => row.caddy.id === 901),
    "MOVE 후에도 9조 HOUSE 유지"
  );
  const cancelled = previewLiveAssignmentChange({
    previous: twoShift,
    regularCaddyPool: pool,
    change: {
      type: "CANCEL_RESERVATION",
      reservationKey: reservationKey(s1[0].reservation),
    },
    teamAffiliation: dbSnap,
  });
  assert(
    cancelled.after.meta.housePoolCount === 4 &&
      cancelled.after.meta.thirdPoolCount === 0,
    "취소 재계산도 HOUSE 풀 유지"
  );
  const sick = previewLiveAssignmentEvents({
    previous: twoShift,
    regularCaddyPool: pool,
    events: [{ type: "REMOVE_CADDY", caddyId: 101, cause: "SICK" }],
    teamAffiliation: dbSnap,
  });
  assert(
    !sick.after.assignments.some((row) => row.caddy.id === 101),
    "병가 캐디 재배치 제외"
  );
  assert(
    sick.after.assignments.some((row) => row.caddy.id === 901),
    "병가 재배치 후에도 9조 HOUSE"
  );

  section("작업본 저장·재로드 + 설정 변경 경고");
  const draft = createDraftFromAutoResult(twoShift, pool);
  assert(
    draft.teamAffiliation != null &&
      sameTeamAffiliationRules(draft.teamAffiliation, dbSnap),
    "작업본에 11/16 스냅샷 보존"
  );
  const reloaded = payloadToAssignmentDraft(
    parseDailyBoardDraftPayload(assignmentDraftToPayload(draft), "2026-11-16")
  );
  assert(
    reloaded.teamAffiliation != null &&
      sameTeamAffiliationRules(reloaded.teamAffiliation, dbSnap),
    "재로드 후에도 11/16 스냅샷"
  );
  const previous = autoResultFromDraft(reloaded, null);
  const live2027 = await loadTeamAffiliationSnapshot("2027-03-01");
  const warned = previewLiveAssignmentChange({
    previous,
    regularCaddyPool: pool,
    change: {
      type: "CANCEL_RESERVATION",
      reservationKey: reservationKey(previous.assignments[0].reservation),
    },
    teamAffiliation: live2027,
  });
  assert(
    warned.warnings.some((row) => row.code === TEAM_AFFILIATION_CHANGED_CODE),
    "조 설정 변경 후 작업본 경고"
  );
  assert(
    warned.after.meta.housePoolCount === 4 &&
      warned.after.meta.thirdPoolCount === 0,
    "경고가 있어도 작업본 소속으로 재계산"
  );

  const refreshed = computeAutoAssignmentsV1({
    date: "2027-03-01",
    available: [
      testCaddy(101, "1조", 1, { caddyType: "HOUSE" }),
      testCaddy(901, "9조", 1, { caddyType: "HOUSE", name: "PR379-9조-복귀" }),
    ],
    reservations: testReservations("2027-03-01", [
      { shift: "1부", count: 1 },
      { shift: "3부", count: 1 },
    ]),
    houseStartCaddyId: 101,
    thirdStartCaddyId: 901,
    teamAffiliation: live2027,
  });
  assert(
    refreshed.regularAssignments.some(
      (row) => row.shift === "1부" && row.caddy.id === 101
    ),
    "새 자동배치는 최신 설정으로 1부는 1조 HOUSE"
  );
  assert(
    refreshed.regularAssignments.some(
      (row) => row.shift === "3부" && row.caddy.id === 901
    ),
    "3부반 복귀 후 9조 THIRD 3부 규칙"
  );

  section("2027 3부 규칙 + 기본 스냅샷 회귀");
  let houseBlocked = false;
  try {
    computeAutoAssignmentsV1({
      date: "2026-11-16",
      available: pool,
      reservations: testReservations("2026-11-16", [{ shift: "3부", count: 1 }]),
      thirdStartCaddyId: 901,
      teamAffiliation: dbSnap,
    });
  } catch (e) {
    houseBlocked = e instanceof ThirdStartCaddyError;
  }
  assert(houseBlocked, "11/16 HOUSE 9조는 3부 첫 캐디 불가");
  const defaultOk = computeAutoAssignmentsV1({
    date: "2026-08-17",
    available: [
      testCaddy(1, "1조", 1, { caddyType: "HOUSE" }),
      testCaddy(9, "9조", 1, { caddyType: "THIRD" }),
    ],
    reservations: testReservations("2026-08-17", [
      { shift: "1부", count: 1 },
      { shift: "3부", count: 1 },
    ]),
    houseStartCaddyId: 1,
    thirdStartCaddyId: 9,
    teamAffiliation: DEFAULT_TEAM_AFFILIATION_SNAPSHOT,
  });
  assert(
    defaultOk.regularAssignments.find((row) => row.shift === "3부")?.caddy.id ===
      9,
    "default 9조 THIRD 3부 규칙 유지"
  );

  const caddiesFinal = await caddyFingerprint();
  const publishedFinal = await publishedFingerprint();
  assert(caddiesFinal === caddiesBefore, "테스트 종료 후에도 캐디 명단 보존");
  assert(publishedFinal === publishedBefore, "테스트 종료 후에도 확정표 보존");
}

main()
  .then(() => {
    if (failed > 0) {
      console.error(`\nFAILED ${failed} / ${passed + failed}`);
      process.exit(1);
    }
    console.log(`\nOK ${passed}`);
  })
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => undefined);
  });
