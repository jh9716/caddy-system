/**
 * Caddy pool / unavailable canonicalization + 2026-08-28 84/93 spare regression.
 * DB write 없음.
 */
import {
  applyLiveResultToDraft,
  autoResultFromDraft,
  createDraftFromAutoResult,
} from "../src/lib/assignmentDraft";
import {
  computeAutoAssignmentsV1,
  reflowRegularAssignments,
  splitCaddyPools,
  type AutoAssignCaddy,
  type AutoAssignReservation,
  type AutoAssignResultV1,
} from "../src/lib/autoAssignEngine";
import {
  assertSpareMatchesBalance,
  houseUsableCount,
  isRosterSizedPool,
  isRosterSizedUnused,
  mergeRosterBaseline,
  recoverComputePool,
  resolveCanonicalUnavailableIds,
  rosterBaselineFromAvailabilityRows,
  snapshotComputePool,
  spareBalance,
  spareForShift,
  usableComputePool,
} from "../src/lib/caddyPoolCanonical";
import { previewLiveAssignmentChange } from "../src/lib/assignmentChange";
import { reservationKey } from "../src/lib/reservationIdentity";
import { COURSE_CODES, type CourseCode, type ShiftPart } from "../src/lib/reservationParser";

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

function houseCaddy(id: number, extra?: Partial<AutoAssignCaddy>): AutoAssignCaddy {
  return {
    id,
    name: `H${id}`,
    team: `${((id - 1) % 8) + 1}조`,
    teamOrder: Math.floor((id - 1) / 8),
    caddyType: "HOUSE",
    employmentStatus: "ACTIVE",
    ...extra,
  };
}

function res(
  date: string,
  id: string,
  shift: ShiftPart,
  teeTime: string,
  course: CourseCode
): AutoAssignReservation {
  return {
    id,
    date,
    course,
    shift,
    teeTime,
    teamName: id,
    rawRowIndex: Number(id.replace(/\D/g, "") || 1),
  };
}

function shiftReservations(
  date: string,
  shift: ShiftPart,
  count: number,
  prefix: string
): AutoAssignReservation[] {
  return Array.from({ length: count }, (_, i) => {
    const hh = shift === "1부" ? 7 : shift === "2부" ? 12 : 16;
    const min = (i * 8) % 60;
    const hour = hh + Math.floor((i * 8) / 60);
    const tee = `${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
    return res(date, `${prefix}${i + 1}`, shift, tee, COURSE_CODES[i % COURSE_CODES.length]);
  });
}

function checkSpares(
  result: AutoAssignResultV1,
  shift: ShiftPart,
  usableHouse: number,
  required: number
) {
  const row = spareForShift(result.sparesByShift, shift);
  const assigned = result.assignments.filter((a) => a.shift === shift).length;
  const unassigned = result.unassignedReservations.filter(
    (u) => u.reservation.shift === shift
  ).length;
  const errors = assertSpareMatchesBalance({
    shift,
    usableHouse,
    requiredTeams: required,
    assigned,
    unassigned,
    spare1: row?.spare1,
    spare2: row?.spare2,
  });
  for (const err of errors) assert(false, err);
  if (errors.length === 0) {
    const bal = spareBalance(usableHouse, required);
    assert(true, `${shift} R=${bal.remainder} spare1=${!!row?.spare1} spare2=${!!row?.spare2}`);
  }
}

section("stale unavailable cleanup");
{
  const ids = resolveCanonicalUnavailableIds({
    dailyUnavailableIds: [1, 2],
    previousUnavailableIds: [27, 8, 1],
    pendingRemoveCaddyIds: [3],
  });
  assert(ids.includes(1) && ids.includes(2) && ids.includes(3), "SoT + pending kept");
  assert(!ids.includes(27) && !ids.includes(8), "stale 손지연/임형규 ids dropped");
}

section("missing pool member recovery");
{
  const baseline = [1, 2, 3, 4, 5, 6].map((id) => houseCaddy(id));
  const corrupted = [1, 2].map((id) => houseCaddy(id));
  const merged = mergeRosterBaseline(corrupted, baseline);
  assert(merged.length === 6, "baseline members restored");
  assert(
    [3, 4, 5, 6].every((id) => merged.some((c) => c.id === id)),
    "lost 6-style ids return"
  );
}

section("off-sheet unmatched does not invent candidates");
{
  const client = [1, 2, 3].map((id) => houseCaddy(id));
  const sot = [1, 2, 3, 4, 5].map((id) => houseCaddy(id));
  const kept = recoverComputePool({
    clientPool: client,
    sotUsable: sot,
    offSheetMatched: false,
  });
  assert(kept.length === 3, "no expansion without date-matched OFF sheet");
  const recovered = recoverComputePool({
    clientPool: client,
    sotUsable: sot,
    offSheetMatched: true,
  });
  assert(recovered.length === 5, "matched OFF sheet restores usable SoT");
  const baselineWithOff = [...sot, houseCaddy(99)];
  const trimmed = recoverComputePool({
    clientPool: baselineWithOff,
    sotUsable: sot,
    offSheetMatched: true,
    unavailableIds: [],
  });
  assert(
    trimmed.length === 5 && !trimmed.some((c) => c.id === 99),
    "matched SoT drops client-only 휴무 extras"
  );
}

section("justified exclusions stay out of compute pool");
{
  const baseline = [1, 2, 3, 4, 5].map((id) => houseCaddy(id));
  const usable = usableComputePool({
    rosterBaseline: baseline,
    unavailableIds: [1],
    offSheetIds: [2],
    specialSkipIds: [3],
    opsDutyIds: [4],
  });
  assert(usable.map((c) => c.id).join(",") === "5", "only non-excluded remains");
}

section("createDraftFromAutoResult never shrinks recovered members");
{
  const date = "2026-09-01";
  const full = Array.from({ length: 8 }, (_, i) => houseCaddy(i + 1));
  const result = computeAutoAssignmentsV1({
    date,
    available: full,
    reservations: shiftReservations(date, "1부", 4, "A"),
  });
  const corrupted = full.slice(0, 4);
  const draft = createDraftFromAutoResult(result, corrupted);
  assert(draft.caddyPool.length >= 8, "merge restores full result pool");
}

section("applyLiveResultToDraft does not union stale unavailable");
{
  const date = "2026-09-02";
  const pool = Array.from({ length: 8 }, (_, i) => houseCaddy(i + 1));
  const result = computeAutoAssignmentsV1({
    date,
    available: pool,
    reservations: shiftReservations(date, "1부", 4, "B"),
  });
  const draft = createDraftFromAutoResult(result, pool);
  draft.unavailableCaddyIds = [27, 8];
  const after: AutoAssignResultV1 = {
    ...result,
    unavailableCaddyIds: [11],
  };
  const next = applyLiveResultToDraft(draft, after);
  assert(
    JSON.stringify(next.unavailableCaddyIds) === JSON.stringify([11]),
    "stale draft unavailable not unioned"
  );
}

section("autoResultFromDraft does not inherit base stale unavailable");
{
  const date = "2026-09-03";
  const pool = Array.from({ length: 6 }, (_, i) => houseCaddy(i + 1));
  const result = computeAutoAssignmentsV1({
    date,
    available: pool,
    reservations: shiftReservations(date, "2부", 3, "C"),
  });
  const draft = createDraftFromAutoResult(result, pool);
  draft.unavailableCaddyIds = [5];
  const base = { ...result, unavailableCaddyIds: [27, 8] };
  const prev = autoResultFromDraft(draft, base);
  assert(prev.unavailableCaddyIds?.includes(5), "draft SoT kept");
  assert(!prev.unavailableCaddyIds?.includes(27), "base stale dropped");
}

section("1부/2부/3부 spare invariant");
{
  const date = "2026-09-04";
  for (const shift of ["1부", "2부", "3부"] as ShiftPart[]) {
    const pool = Array.from({ length: 12 }, (_, i) => houseCaddy(i + 1));
    const reservations = shiftReservations(date, shift, 10, shift[0]);
    const result = computeAutoAssignmentsV1({
      date,
      available: pool,
      reservations,
    });
    const usable = houseUsableCount(pool);
    checkSpares(result, shift, usable, 10);
  }
}

section("병가 pull-forward keeps spare2 when R>=2");
{
  const date = "2026-09-05";
  const pool = Array.from({ length: 13 }, (_, i) => houseCaddy(i + 1));
  const previous = computeAutoAssignmentsV1({
    date,
    available: pool,
    reservations: shiftReservations(date, "2부", 10, "S"),
  });
  checkSpares(previous, "2부", 13, 10);
  const victim = previous.assignments.find((a) => a.shift === "2부")!;
  const afterSick = reflowRegularAssignments({
    previous,
    regularCaddyPool: pool.filter((c) => c.id !== victim.caddy.id),
    events: [
      {
        type: "REMOVE_CADDY",
        caddyId: victim.caddy.id,
        cause: "SICK",
        fromShift: "2부",
      },
    ],
  });
  checkSpares(afterSick.after, "2부", 12, 10);
  const beforeSpare1 = previous.sparesByShift.find((s) => s.shift === "2부")?.spare1;
  const afterSpare1 = afterSick.after.sparesByShift.find((s) => s.shift === "2부")?.spare1;
  const afterSpare2 = afterSick.after.sparesByShift.find((s) => s.shift === "2부")?.spare2;
  assert(!!afterSpare1 && !!afterSpare2, "after sick both spares remain when R>=2");
  if (beforeSpare1?.caddyId) {
    const used = afterSick.after.assignments.some(
      (a) => a.shift === "2부" && a.caddy.id === beforeSpare1.caddyId
    );
    assert(
      used || afterSpare1?.caddyId === beforeSpare1.caddyId,
      "old spare1 pulled forward or stays spare1"
    );
  }
}

section("연속 병가 spare refresh");
{
  const date = "2026-09-06";
  const pool = Array.from({ length: 14 }, (_, i) => houseCaddy(i + 1));
  let current = computeAutoAssignmentsV1({
    date,
    available: pool,
    reservations: shiftReservations(date, "2부", 10, "T"),
  });
  checkSpares(current, "2부", 14, 10);
  for (let i = 0; i < 2; i++) {
    const victim = current.assignments.find((a) => a.shift === "2부")!;
    const remain = pool.filter(
      (c) =>
        c.id !== victim.caddy.id &&
        !(current.unavailableCaddyIds || []).includes(c.id)
    );
    const next = reflowRegularAssignments({
      previous: current,
      regularCaddyPool: remain,
      events: [
        {
          type: "REMOVE_CADDY",
          caddyId: victim.caddy.id,
          cause: "SICK",
          fromShift: "2부",
        },
      ],
    });
    current = next.after;
    const left = 14 - (i + 1);
    checkSpares(current, "2부", left, 10);
  }
}

section("MOVE→SICK / SICK→MOVE");
{
  const date = "2026-09-07";
  const pool = Array.from({ length: 12 }, (_, i) => houseCaddy(i + 1));
  const reservations = [
    ...shiftReservations(date, "1부", 6, "M1"),
    ...shiftReservations(date, "2부", 6, "M2"),
  ];
  const previous = computeAutoAssignmentsV1({
    date,
    available: pool,
    reservations,
  });
  const row = previous.assignments.find((a) => a.shift === "1부")!;
  const moved = previewLiveAssignmentChange({
    previous,
    regularCaddyPool: pool,
    change: {
      type: "MOVE_RESERVATION",
      reservationKey: reservationKey(row.reservation),
      to: { course: "LAKE", shift: "1부", teeTime: "09:40" },
    },
  });
  assert(moved.after.assignments.length === previous.assignments.length, "MOVE keeps count");
  const sickAfterMove = previewLiveAssignmentChange({
    previous: moved.after,
    regularCaddyPool: pool.filter((c) => c.id !== row.caddy.id),
    change: {
      type: "CADDY_SICK",
      caddyId: row.caddy.id,
      shift: "1부",
    },
  });
  assert(
    !sickAfterMove.after.assignments.some((a) => a.caddy.id === row.caddy.id),
    "MOVE then SICK removes caddy"
  );

  const firstSick = previewLiveAssignmentChange({
    previous,
    regularCaddyPool: pool.filter((c) => c.id !== row.caddy.id),
    change: {
      type: "CADDY_SICK",
      caddyId: row.caddy.id,
      shift: "1부",
    },
  });
  const other = firstSick.after.assignments.find((a) => a.shift === "1부")!;
  const moveAfterSick = previewLiveAssignmentChange({
    previous: firstSick.after,
    regularCaddyPool: pool.filter((c) => c.id !== row.caddy.id),
    change: {
      type: "MOVE_RESERVATION",
      reservationKey: reservationKey(other.reservation),
      to: { course: "OCEAN", shift: "1부", teeTime: "09:48" },
    },
  });
  assert(
    !moveAfterSick.after.assignments.some((a) => a.caddy.id === row.caddy.id),
    "SICK then MOVE does not resurrect sick caddy"
  );
}

section("2026-08-28 corrupted 84/93 fixture");
{
  const date = "2026-08-28";
  const NAMES: Record<number, string> = {
    8: "임형규",
    27: "손지연",
    28: "김윤정",
    30: "한재만",
    32: "김진희1",
    34: "변수민",
    131: "박익수",
    140: "박정은",
  };
  const STALE_IDS = [8, 27];
  const MISSING_POOL_IDS = [28, 30, 32, 34, 131, 140];
  const UNJUST_IDS = [...STALE_IDS, ...MISSING_POOL_IDS];
  const SICK_IDS = [1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12];
  const SPECIAL_IDS = [47, 48];
  const RETIRED_ID = 142;
  const reserved = new Set([...SICK_IDS, ...SPECIAL_IDS, RETIRED_ID, ...UNJUST_IDS]);
  const allHouse = Array.from({ length: 142 }, (_, i) => {
    const id = i + 1;
    return houseCaddy(id, {
      name: NAMES[id] || `H${id}`,
      employmentStatus: id === RETIRED_ID ? "RETIRED" : "ACTIVE",
    });
  });
  const off = allHouse.filter((c) => !reserved.has(c.id)).slice(0, 35);
  const offIds = new Set(off.map((c) => c.id));
  const sick = allHouse.filter((c) => SICK_IDS.includes(c.id));
  const oneThree = allHouse.filter((c) => SPECIAL_IDS.includes(c.id));
  const staleUnavail = allHouse.filter((c) => STALE_IDS.includes(c.id));
  const missingPool = allHouse.filter((c) => MISSING_POOL_IDS.includes(c.id));
  const usable = allHouse.filter(
    (c) =>
      !SICK_IDS.includes(c.id) &&
      !offIds.has(c.id) &&
      !SPECIAL_IDS.includes(c.id) &&
      c.id !== RETIRED_ID
  );
  const corruptedPool = usable.filter((c) => !UNJUST_IDS.includes(c.id));

  assert(allHouse.length === 142, "HOUSE baseline 142");
  assert(sick.length === 11, "병가 11");
  assert(off.length === 35, "휴무 35");
  assert(oneThree.length === 2, "1·3 2");
  assert(staleUnavail.length === 2, "stale unavailable 2");
  assert(missingPool.length === 6, "missing pool 6");
  assert(usable.length === 93, "usable 93");
  assert(corruptedPool.length === 85, "corrupted engine pool 85");

  const reservations = shiftReservations(date, "2부", 84, "P");
  const broken = computeAutoAssignmentsV1({
    date,
    available: corruptedPool,
    reservations,
    oneThreeCandidates: oneThree,
  });
  const brokenSpare = spareForShift(broken.sparesByShift, "2부");
  assert(broken.assignments.filter((a) => a.shift === "2부").length === 84, "broken still fills 84");
  assert(!!brokenSpare?.spare1, "broken has spare1");
  assert(!brokenSpare?.spare2, "broken spare2 is null");

  const recoveredPool = recoverComputePool({
    clientPool: corruptedPool,
    sotUsable: usable,
    offSheetMatched: true,
    unavailableIds: sick.map((c) => c.id),
    specialSkipIds: oneThree.map((c) => c.id),
  });
  assert(recoveredPool.length === 93, "canonical usable 93 restored");
  assert(
    staleUnavail.every((c) => recoveredPool.some((x) => x.id === c.id)),
    "손지연/임형규 back in candidates"
  );
  assert(
    missingPool.every((c) => recoveredPool.some((x) => x.id === c.id)),
    "6 missing pool members restored"
  );
  assert(
    ![...sick, ...off, ...oneThree, allHouse[141]].some((c) =>
      recoveredPool.some((x) => x.id === c.id)
    ),
    "justified 병가/휴무/퇴사/1·3 stay excluded"
  );

  const resurrectAttempt = recoverComputePool({
    clientPool: mergeRosterBaseline(corruptedPool, [...sick, ...usable]),
    sotUsable: usable,
    offSheetMatched: true,
    unavailableIds: sick.map((c) => c.id),
    specialSkipIds: oneThree.map((c) => c.id),
  });
  assert(
    !sick.some((c) => resurrectAttempt.some((x) => x.id === c.id)),
    "current sick stay out of compute pool"
  );
  assert(resurrectAttempt.length === 93, "recovery does not use sick to pad count");

  const fixed = computeAutoAssignmentsV1({
    date,
    available: recoveredPool,
    reservations,
    oneThreeCandidates: oneThree,
  });
  const house = splitCaddyPools(recoveredPool).house;
  checkSpares(fixed, "2부", house.length, 84);
  const fixedSpare = spareForShift(fixed.sparesByShift, "2부");
  assert(!!fixedSpare?.spare1 && !!fixedSpare?.spare2, "fixed spare1+spare2 exist");
  assert(fixed.unassignedReservations.length === 0, "no unassigned after recovery");

  const recoveredBaseline = mergeRosterBaseline(corruptedPool, usable);
  const staleDraft = createDraftFromAutoResult(broken, corruptedPool);
  staleDraft.unavailableCaddyIds = [...sick.map((c) => c.id), 27, 8];
  const hydrated = applyLiveResultToDraft(staleDraft, {
    ...fixed,
    unusedCaddies: recoveredPool.filter(
      (c) => !fixed.assignments.some((a) => a.caddy.id === c.id)
    ),
    unavailableCaddyIds: sick.map((c) => c.id),
  });
  const hydratedPool = mergeRosterBaseline(hydrated.caddyPool, recoveredBaseline);
  assert(
    staleUnavail.every((c) => hydratedPool.some((x) => x.id === c.id)),
    "hydrate/reflow restores stale-unavailable people into pool"
  );
  assert(
    !hydrated.unavailableCaddyIds?.includes(27) &&
      !hydrated.unavailableCaddyIds?.includes(8),
    "hydrate drops stale unavailable ids"
  );
}

section("roster baseline keeps temporarily excluded people");
{
  const rows = [
    { id: 1, name: "A", team: "1조", teamOrder: 1, employmentStatus: "ACTIVE" },
    { id: 2, name: "B", team: "1조", teamOrder: 2, employmentStatus: "ACTIVE", excludedReasons: ["휴무"] },
    { id: 3, name: "C", team: "1조", teamOrder: 3, employmentStatus: "RETIRED" },
    { id: 4, name: "D", team: "1조", teamOrder: 4, employmentStatus: "LEAVE" },
  ];
  const baseline = rosterBaselineFromAvailabilityRows(rows);
  assert(baseline.some((c) => c.id === 2), "휴무 stays in baseline");
  assert(!baseline.some((c) => c.id === 3), "RETIRED out of baseline");
  assert(!baseline.some((c) => c.id === 4), "LEAVE out of baseline");
}

section("snapshotComputePool ignores baseline-sized unused");
{
  const assigned = Array.from({ length: 84 }, (_, i) => houseCaddy(i + 1));
  const leftover = Array.from({ length: 9 }, (_, i) => houseCaddy(200 + i));
  const off = Array.from({ length: 80 }, (_, i) => houseCaddy(400 + i));
  const baseline = [...assigned, ...leftover, ...off];
  const polluted = [...leftover, ...off];
  assert(
    isRosterSizedUnused({
      rosterBaselineCount: baseline.length,
      assignedCount: assigned.length,
      unusedCount: polluted.length,
    }),
    "baseline-minus-assigned unused is polluted"
  );
  assert(
    !isRosterSizedUnused({
      rosterBaselineCount: baseline.length,
      assignedCount: assigned.length,
      unusedCount: leftover.length,
    }),
    "engine leftover is not polluted"
  );
  assert(!isRosterSizedPool(93, 173), "93-usable is not roster-sized vs 173");
  assert(isRosterSizedPool(173, 173), "full baseline is roster-sized");
  const fromEngine = snapshotComputePool({
    rosterBaseline: baseline,
    assigned,
    spareIds: [leftover[0].id, leftover[1].id],
    engineUnused: leftover,
  });
  assert(fromEngine.length <= 93, "engine snapshot stays compute-sized");
  assert(
    leftover.every((c) => fromEngine.some((x) => x.id === c.id)),
    "engine leftover stays in snapshot"
  );
  assert(
    !fromEngine.some((c) => c.id === off[0].id),
    "휴무 not admitted from polluted unused"
  );
  const fromPolluted = snapshotComputePool({
    rosterBaseline: baseline,
    assigned,
    spareIds: [leftover[0].id],
    engineUnused: polluted,
  });
  assert(
    !fromPolluted.some((c) => c.id === off[0].id),
    "polluted unused does not resurrect 휴무"
  );
  assert(
    fromPolluted.some((c) => c.id === leftover[0].id),
    "spare from polluted fallback is kept"
  );
  const extraUsable = [...assigned, ...leftover];
  const fromAvail = snapshotComputePool({
    rosterBaseline: baseline,
    assigned,
    extraUsable,
    unavailableIds: [assigned[0].id],
  });
  assert(
    !fromAvail.some((c) => c.id === assigned[0].id),
    "snapshot drops current unavailable"
  );
  assert(
    !fromAvail.some((c) => c.id === off[0].id),
    "availability usable does not include 휴무"
  );
}

section("source: no stale unavailable union / no destructive pool shrink");
{
  const fs = require("node:fs") as typeof import("node:fs");
  const read = (rel: string) => fs.readFileSync(`${process.cwd()}/${rel}`, "utf8");
  const apply = read("src/lib/quickBoardMutationApply.ts");
  const draft = read("src/lib/assignmentDraft.ts");
  const page = read("src/app/manage/assignments/page.tsx");
  const reflow = read("src/app/api/assignments/reflow/route.ts");
  assert(
    !/previous\.unavailableCaddyIds\s*\|\|\s*\[\]/.test(
      apply.split("resolveCanonicalUnavailableIds")[0] || apply
    ),
    "quick mutation does not seed from previous unavailable before SoT"
  );
  assert(
    /resolveCanonicalUnavailableIds/.test(apply) &&
      /loadCanonicalReflowState/.test(apply) &&
      /offSheetMode:\s*"cache"/.test(apply) &&
      /skipCanonicalReload/.test(apply),
    "quick mutation rebuilds SoT from cache-only canonical, no double fetch"
  );
  assert(
    /uniquePositiveIds\(after\.unavailableCaddyIds/.test(draft),
    "applyLiveResultToDraft uses after unavailable only"
  );
  assert(
    /uniquePositiveIds\(draft\.unavailableCaddyIds/.test(draft) &&
      !/base\?\.unavailableCaddyIds/.test(
        draft.split("export function autoResultFromDraft")[1]?.split(
          "export function applyLiveResultToDraft"
        )[0] || ""
      ),
    "autoResultFromDraft does not union base stale unavailable"
  );
  assert(
    /unavailableIds !== undefined/.test(page) &&
      /data\.unavailableCaddyIds/.test(page),
    "hydrate prefers server DailyCaddyUnavailable"
  );
  assert(
    /mergeRosterBaseline/.test(page) &&
      /snapshotComputePoolFromDraft/.test(page) &&
      /scheduleAfterPaint/.test(page),
    "client keeps baseline and projects from snapshot after paint"
  );
  const offFetch = read("src/lib/offSheetFetch.ts");
  const service = read("src/lib/caddyPoolCanonicalService.ts");
  const route = read("src/app/api/assignments/reflow/quick-mutation/route.ts");
  assert(/peekCachedOffSheets/.test(offFetch), "off-sheet cache can be peeked");
  assert(
    /offSheetMode === "cache"/.test(service) &&
      /peekCachedOffSheets/.test(service),
    "canonical cache mode does not call Google"
  );
  assert(
    /offSheetMode:\s*"cache"/.test(route) &&
      /skipCanonicalReload:\s*true/.test(route) &&
      !/fetchPublishedOffSheets/.test(route),
    "quick-mutation route is cache-only and single-load"
  );
  assert(
    /resolved\.unavailableIds/.test(reflow),
    "reflow overwrites previous unavailable with current SoT"
  );
}

if (failed > 0) {
  console.error(`\nFAILED ${failed}  passed ${passed}`);
  process.exit(1);
}
console.log(`\nAll ${passed} assertions passed`);
