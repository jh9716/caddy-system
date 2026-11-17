/**
 * 휴직·퇴사자 배치 차단 회귀 (DB 없음)
 * 실행: npx tsx scripts/test-assignable-roster-unit.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyLatestEmploymentToDraft,
  assignCaddyToUnassigned,
  createDraftFromAutoResult,
  detectDraftWarnings,
  replaceAssignmentCaddy,
  unusedCaddies,
  type AssignmentDraft,
} from "../src/lib/assignmentDraft";
import {
  applyDirectCaddyEdit,
  listDirectEditCandidates,
} from "../src/lib/assignmentBoardCellEdit";
import {
  INACTIVE_EMPLOYMENT_WARNING_CODE,
  blockedByInactiveEmploymentMessage,
  collectPlacedCaddyRefs,
  employmentRowsFromAvailability,
  employmentStatusById,
  filterAssignableCaddies,
  inactiveEmploymentIssuesFromDb,
  isAssignableCaddy,
  isAssignableEmploymentStatus,
  missingPlacedCaddyRefs,
  overlayLatestEmploymentStatus,
  unknownPlacedCaddyMessage,
} from "../src/lib/assignableRoster";
import {
  computeAutoAssignmentsV1,
  eligibleRegularReflowCaddies,
  reservationKey,
  type AutoAssignCaddy,
  type AutoAssignReservation,
} from "../src/lib/autoAssignEngine";
import {
  computeAvailability,
} from "../src/lib/availabilityEngine";
import {
  mergeRosterBaseline,
  recoverComputePool,
  rosterBaselineFromAvailability,
} from "../src/lib/caddyPoolCanonical";
import {
  isOperationalCaddy,
  isOperationalEmploymentStatus,
} from "../src/lib/operationalRoster";
import { buildEngineSpecialBundles } from "../src/lib/dailySpecialDuty";
import { isEligibleSpecialSupportCandidate } from "../src/lib/dailySpecialSupport";

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

function house(
  id: number,
  extra: Partial<AutoAssignCaddy> = {}
): AutoAssignCaddy {
  return {
    id,
    name: extra.name || `캐디${id}`,
    team: extra.team || `${((id - 1) % 8) + 1}조`,
    teamOrder: extra.teamOrder ?? id,
    caddyType: extra.caddyType || "HOUSE",
    employmentStatus: extra.employmentStatus ?? "ACTIVE",
  };
}

function res(
  date: string,
  id: string,
  extra: Partial<AutoAssignReservation> = {}
): AutoAssignReservation {
  return {
    id,
    date,
    course: extra.course || "SKY",
    shift: extra.shift || "1부",
    teeTime: extra.teeTime || "07:00",
    teamName: extra.teamName || id,
    rawRowIndex: extra.rawRowIndex ?? 2,
  };
}

function assignedIds(result: { assignments: Array<{ caddy: { id: number } }> }) {
  return result.assignments.map((row) => row.caddy.id);
}

function spareIds(result: {
  sparesByShift?: Array<{
    spare1?: { caddyId?: number } | null;
    spare2?: { caddyId?: number } | null;
  }>;
}): number[] {
  const ids: number[] = [];
  for (const row of result.sparesByShift || []) {
    if (row.spare1?.caddyId) ids.push(row.spare1.caddyId);
    if (row.spare2?.caddyId) ids.push(row.spare2.caddyId);
  }
  return ids;
}

function emptyDraft(extra: Partial<AssignmentDraft> = {}): AssignmentDraft {
  return {
    date: "2026-11-14",
    status: "DRAFT",
    assignments: [],
    unassignedReservations: [],
    closedCourseReservations: [],
    openCourses: ["SKY"],
    caddyPool: [],
    sparesByShift: [],
    confirmedAt: null,
    ...extra,
  };
}

section("운영 명단과 배치 가능 인원은 분리");
{
  assert(isOperationalEmploymentStatus("LEAVE") === true, "LEAVE stays operational");
  assert(isOperationalCaddy({ id: 1, employmentStatus: "LEAVE" }) === true, "LEAVE operational caddy");
  assert(isAssignableEmploymentStatus("LEAVE") === false, "LEAVE not assignable");
  assert(isAssignableCaddy({ id: 1, employmentStatus: "LEAVE" }) === false, "LEAVE not assignable caddy");
  assert(isAssignableEmploymentStatus("RETIRED") === false, "RETIRED not assignable");
  assert(isAssignableEmploymentStatus("ACTIVE") === true, "ACTIVE assignable");
  assert(isAssignableEmploymentStatus(undefined) === true, "missing status stays test-compat assignable");
  assert(
    filterAssignableCaddies([
      house(1, { employmentStatus: "ACTIVE" }),
      house(2, { employmentStatus: "LEAVE" }),
      house(3, { employmentStatus: "RETIRED" }),
    ]).map((c) => c.id).join(",") === "1",
    "filter drops LEAVE/RETIRED"
  );
  const rosterSrc = readFileSync(
    join(process.cwd(), "src/lib/operationalRoster.ts"),
    "utf8"
  );
  assert(
    !rosterSrc.includes("LEAVE") || /LEAVE stays operational|ACTIVE remains/.test(rosterSrc) ||
      !/NON_OPERATIONAL_STATUS[\s\S]*LEAVE/.test(rosterSrc),
    "operationalRoster does not globally ban LEAVE"
  );
  assert(
    !/NON_OPERATIONAL_STATUS = new Set\(\[[^\]]*LEAVE/.test(rosterSrc),
    "LEAVE is not in NON_OPERATIONAL_STATUS"
  );
}

section("가용 엔진은 LEAVE를 available에서 제외");
{
  const date = "2026-11-14";
  const availability = computeAvailability({
    date,
    caddies: [
      house(1, { name: "재직", employmentStatus: "ACTIVE" }),
      house(2, { name: "휴직", employmentStatus: "LEAVE" }),
      house(3, { name: "퇴사", employmentStatus: "RETIRED" }),
    ],
  });
  assert(
    availability.available.all.map((c) => c.id).join(",") === "1",
    "available only ACTIVE"
  );
  assert(
    availability.excluded.some((c) => c.id === 2 && c.employmentStatus === "LEAVE"),
    "LEAVE goes to excluded"
  );
}

section("예약 Excel 기반 자동배치: available에 섞여 들어온 LEAVE/RETIRED는 배치·스페어 금지");
{
  const date = "2026-11-14";
  const leave = house(1, { name: "휴직자", team: "1조", teamOrder: 1, employmentStatus: "LEAVE" });
  const retired = house(2, { name: "퇴사자", team: "1조", teamOrder: 2, employmentStatus: "RETIRED" });
  const active = [
    house(10, { name: "A", team: "1조", teamOrder: 10 }),
    house(11, { name: "B", team: "1조", teamOrder: 11 }),
    house(12, { name: "C", team: "1조", teamOrder: 12 }),
    house(13, { name: "D", team: "1조", teamOrder: 13 }),
    house(14, { name: "E", team: "1조", teamOrder: 14 }),
  ];
  const result = computeAutoAssignmentsV1({
    date,
    available: [leave, retired, ...active],
    reservations: [
      res(date, "A1", { teeTime: "07:00" }),
      res(date, "A2", { teeTime: "07:08" }),
      res(date, "A3", { teeTime: "07:16" }),
    ],
  });
  const ids = assignedIds(result);
  assert(!ids.includes(1) && !ids.includes(2), "LEAVE/RETIRED not in assignments");
  assert(
    spareIds(result).every((id) => id !== 1 && id !== 2),
    "LEAVE/RETIRED not in spares"
  );
  assert(
    result.unusedCaddies.every((c) => c.id !== 1 && c.id !== 2),
    "engine unused drops LEAVE/RETIRED"
  );
  assert(ids.includes(10) && ids.includes(11) && ids.includes(12), "ACTIVE still assigned in order");
  const staleDirectory = computeAutoAssignmentsV1({
    date,
    available: [leave, ...active],
    caddyDirectory: [
      { ...leave, employmentStatus: "ACTIVE" },
      ...active,
    ],
    reservations: [res(date, "A1"), res(date, "A2"), res(date, "A3")],
  });
  assert(
    !assignedIds(staleDirectory).includes(1),
    "stale ACTIVE directory does not override LEAVE on available"
  );
}

section("기존 Draft 재계산: stale ACTIVE 작업본은 최신 DB LEAVE를 덮어쓴다");
{
  const date = "2026-11-14";
  const stale = house(7, { name: "휴직자", team: "1조", teamOrder: 1, employmentStatus: "ACTIVE" });
  const active = house(8, { name: "재직자", team: "1조", teamOrder: 2, employmentStatus: "ACTIVE" });
  const availability = computeAvailability({
    date,
    caddies: [
      { ...stale, employmentStatus: "LEAVE" },
      active,
    ],
  });
  const merged = mergeRosterBaseline([stale, active], rosterBaselineFromAvailability(availability));
  assert(
    merged.some((c) => c.id === 7),
    "never-shrink keeps stale member in roster baseline"
  );
  const overlaid = overlayLatestEmploymentStatus(
    merged,
    employmentRowsFromAvailability(availability)
  );
  assert(
    overlaid.find((c) => c.id === 7)?.employmentStatus === "LEAVE",
    "overlay restores latest LEAVE"
  );
  const compute = eligibleRegularReflowCaddies(overlaid);
  assert(!compute.some((c) => c.id === 7), "recalc compute pool drops overlaid LEAVE");
  const result = computeAutoAssignmentsV1({
    date,
    available: overlaid,
    reservations: [res(date, "A1")],
  });
  assert(
    !assignedIds(result).includes(7),
    "recalc does not assign stale-ACTIVE-now-LEAVE"
  );
  assert(assignedIds(result).includes(8), "ACTIVE still assigned after overlay");
}

section("reflow: 클라이언트 풀 stale ACTIVE + DB LEAVE");
{
  const leave = house(21, { name: "휴직", employmentStatus: "ACTIVE" });
  const active = house(22, { name: "재직" });
  const overlaid = overlayLatestEmploymentStatus(
    [leave, active],
    [house(21, { employmentStatus: "LEAVE" }), active]
  );
  const pool = recoverComputePool({
    clientPool: overlaid,
    sotUsable: [active],
    offSheetMatched: false,
  });
  assert(!pool.some((c) => c.id === 21), "unmatched-off reflow drops overlaid LEAVE");
  assert(pool.some((c) => c.id === 22), "ACTIVE remains in reflow pool");
}

section("수동 캐디 변경·미배치 지정은 LEAVE/RETIRED 거부");
{
  const date = "2026-11-14";
  const leave = house(31, { name: "휴직자", employmentStatus: "LEAVE" });
  const retired = house(32, { name: "퇴사자", employmentStatus: "RETIRED" });
  const active = house(33, { name: "재직자" });
  const result = computeAutoAssignmentsV1({
    date,
    available: [active, house(34), house(35)],
    reservations: [res(date, "A1"), res(date, "U1", { teeTime: "07:08" })],
  });
  const draft = createDraftFromAutoResult(result, [leave, retired, active, house(34), house(35)]);
  assert(
    unusedCaddies(draft).every((c) => c.id !== 31 && c.id !== 32),
    "unused picker drops LEAVE/RETIRED"
  );
  const key = reservationKey(draft.assignments[0].reservation);
  const leaveReplace = replaceAssignmentCaddy(draft, key, leave.id);
  assert(
    leaveReplace.warnings.some((w) => w.code === INACTIVE_EMPLOYMENT_WARNING_CODE),
    "manual replace rejects LEAVE"
  );
  assert(
    leaveReplace.draft.assignments[0].caddy.id !== leave.id,
    "LEAVE not written onto the slot"
  );
  const unassignedKey = reservationKey(draft.unassignedReservations[0]?.reservation || draft.assignments[1].reservation);
  const draftWithUnassigned = {
    ...draft,
    unassignedReservations: [
      { reservation: res(date, "U1", { teeTime: "07:08" }), reason: "TEST" },
    ],
  };
  const assignedLeave = assignCaddyToUnassigned(draftWithUnassigned, unassignedKey, leave.id);
  assert(
    assignedLeave.warnings.some((w) => w.code === INACTIVE_EMPLOYMENT_WARNING_CODE),
    "manual assign-unassigned rejects LEAVE"
  );
  const candidates = listDirectEditCandidates(draft, {
    shift: "1부",
    currentCaddyId: draft.assignments[0].caddy.id,
  });
  assert(
    candidates.every((c) => c.caddy.id !== leave.id && c.caddy.id !== retired.id),
    "direct-edit unassigned candidates omit LEAVE/RETIRED"
  );
  const direct = applyDirectCaddyEdit(draft, {
    reservationKey: key,
    caddyId: leave.id,
  });
  assert(direct.ok === false, "direct edit apply blocks LEAVE");
}

section("이미 배치된 캐디가 휴직이면 충돌 안내, 슬롯은 유지");
{
  const leave = house(41, { name: "기존휴직", employmentStatus: "LEAVE" });
  const active = house(42, { name: "재직" });
  const reservation = res("2026-11-14", "KEEP", { teeTime: "07:00" });
  const draft = emptyDraft({
    caddyPool: [leave, active],
    assignments: [
      {
        date: "2026-11-14",
        shift: "1부",
        sequenceIndex: 0,
        reason: "REGULAR_SEQUENCE",
        reservation,
        caddy: house(41, { name: "기존휴직", employmentStatus: "ACTIVE" }),
        pairId: null,
        kind: "regular",
      },
    ],
    sparesByShift: [
      {
        shift: "1부",
        spare1: { caddyId: 41, name: "기존휴직", team: "1조", teamOrder: 41 },
        spare2: null,
      },
    ],
  });
  const live = applyLatestEmploymentToDraft(draft, [
    { id: 41, employmentStatus: "LEAVE" },
    { id: 42, employmentStatus: "ACTIVE" },
  ]);
  assert(live && live.assignments[0].caddy.id === 41, "existing assignment kept");
  assert(live?.assignments[0].caddy.employmentStatus === "LEAVE", "assignment employment refreshed");
  const warnings = detectDraftWarnings(live!);
  assert(
    warnings.some(
      (w) =>
        w.code === INACTIVE_EMPLOYMENT_WARNING_CODE &&
        w.caddyId === 41 &&
        /휴직/.test(w.message)
    ),
    "admin warning for already-assigned LEAVE"
  );
}

section("스페어·특수근무·지원근무 후보에서 LEAVE 제외");
{
  const date = "2026-11-14";
  const leave = house(51, { name: "휴직스페어", team: "1조", teamOrder: 1, employmentStatus: "LEAVE" });
  const actives = Array.from({ length: 6 }, (_, i) =>
    house(60 + i, { team: "1조", teamOrder: 10 + i })
  );
  const result = computeAutoAssignmentsV1({
    date,
    available: [leave, ...actives],
    reservations: [res(date, "A1"), res(date, "A2")],
  });
  assert(
    spareIds(result).every((id) => id !== 51),
    "spare calculation omits LEAVE"
  );
  const bundles = buildEngineSpecialBundles(
    [
      {
        kind: "ONE_TWO",
        caddyId: 51,
        sortOrder: 1,
        name: "휴직스페어",
        team: "1조",
        teamOrder: 1,
        employmentStatus: "LEAVE",
      },
    ],
    new Map()
  );
  assert(
    (bundles.oneTwoCandidates || []).every((c) => c.id !== 51),
    "special duty engine skips LEAVE"
  );
  assert(
    !isEligibleSpecialSupportCandidate({
      id: 51,
      name: "휴직스페어",
      team: "1조",
      teamOrder: 1,
      employmentStatus: "LEAVE",
      excludedReasons: ["휴무"],
    }),
    "special support candidate excludes LEAVE"
  );
}

section("재직 상태 병합: stale ACTIVE는 LEAVE를 덮지 못하고, DB 권위 ACTIVE는 복귀");
{
  const mixed = employmentStatusById([
    { id: 1, employmentStatus: "LEAVE" },
    { id: 1, employmentStatus: "ACTIVE" },
  ]);
  assert(mixed.get(1) === "LEAVE", "prefer-inactive keeps LEAVE over later ACTIVE");
  const mixedRev = employmentStatusById([
    { id: 2, employmentStatus: "ACTIVE" },
    { id: 2, employmentStatus: "LEAVE" },
  ]);
  assert(mixedRev.get(2) === "LEAVE", "prefer-inactive later LEAVE still wins");
  const staleActive = house(81, { name: "휴직자", employmentStatus: "ACTIVE" });
  const active = house(82, { name: "재직" });
  const leaveWins = overlayLatestEmploymentStatus(
    [staleActive, active],
    [
      { id: 81, employmentStatus: "ACTIVE" },
      { id: 81, employmentStatus: "LEAVE" },
    ]
  );
  assert(
    leaveWins.find((c) => c.id === 81)?.employmentStatus === "LEAVE",
    "overlay mixed source drops stale ACTIVE"
  );
  const authLeave = overlayLatestEmploymentStatus(
    [staleActive, active],
    [staleActive, active],
    [{ id: 81, employmentStatus: "LEAVE" }, active]
  );
  assert(
    authLeave.find((c) => c.id === 81)?.employmentStatus === "LEAVE",
    "DB authority LEAVE overrides stale ACTIVE source"
  );
  const authReturn = overlayLatestEmploymentStatus(
    [house(81, { employmentStatus: "LEAVE" }), active],
    [house(81, { employmentStatus: "LEAVE" })],
    [{ id: 81, employmentStatus: "ACTIVE" }, active]
  );
  assert(
    authReturn.find((c) => c.id === 81)?.employmentStatus === "ACTIVE",
    "DB authority ACTIVE restores returned caddy"
  );
  const engineLeave = computeAutoAssignmentsV1({
    date: "2026-11-14",
    available: [staleActive, active, house(83), house(84)],
    employmentAuthority: [
      { id: 81, employmentStatus: "LEAVE" },
      { id: 82, employmentStatus: "ACTIVE" },
      { id: 83, employmentStatus: "ACTIVE" },
      { id: 84, employmentStatus: "ACTIVE" },
    ],
    reservations: [res("2026-11-14", "A1"), res("2026-11-14", "A2")],
  });
  assert(
    !assignedIds(engineLeave).includes(81),
    "engine authority LEAVE is not assigned despite stale ACTIVE available"
  );
  assert(assignedIds(engineLeave).includes(82), "engine still assigns ACTIVE");
  const engineReturn = computeAutoAssignmentsV1({
    date: "2026-11-14",
    available: [
      house(91, { name: "복귀", employmentStatus: "LEAVE" }),
      house(92),
    ],
    employmentAuthority: [
      { id: 91, employmentStatus: "ACTIVE" },
      { id: 92, employmentStatus: "ACTIVE" },
    ],
    reservations: [res("2026-11-14", "A1")],
  });
  assert(
    assignedIds(engineReturn).includes(91),
    "engine authority ACTIVE can be auto-assigned after leave"
  );
}

section("공개 확정은 휴직·퇴사 배치를 차단하고 대상을 안내");
{
  const placed = collectPlacedCaddyRefs({
    assignments: [
      { caddy: { id: 1, name: "휴직자" } },
      { caddy: { id: 2, name: "재직자" } },
    ],
    sparesByShift: [
      { spare1: { caddyId: 3, name: "퇴사스페어" }, spare2: null },
    ],
  });
  assert(
    placed.map((p) => p.id).join(",") === "1,2,3",
    "collect assignments + spare ids"
  );
  const leaveIssues = inactiveEmploymentIssuesFromDb(placed, [
    { id: 1, name: "휴직자", employmentStatus: "LEAVE" },
    { id: 2, name: "재직자", employmentStatus: "ACTIVE" },
    { id: 3, name: "퇴사스페어", employmentStatus: "ACTIVE" },
  ]);
  assert(leaveIssues.length === 1 && leaveIssues[0].caddyId === 1, "LEAVE placed blocked");
  assert(/휴직자\(휴직\)/.test(leaveIssues[0].message), "admin message names 휴직자");
  const retiredIssues = inactiveEmploymentIssuesFromDb(placed, [
    { id: 1, name: "휴직자", employmentStatus: "ACTIVE" },
    { id: 2, name: "재직자", employmentStatus: "ACTIVE" },
    { id: 3, name: "퇴사스페어", employmentStatus: "RETIRED" },
  ]);
  assert(
    retiredIssues.length === 1 && retiredIssues[0].caddyId === 3,
    "RETIRED spare blocked"
  );
  const ok = inactiveEmploymentIssuesFromDb(placed, [
    { id: 1, employmentStatus: "ACTIVE" },
    { id: 2, employmentStatus: "ACTIVE" },
    { id: 3, employmentStatus: "ACTIVE" },
  ]);
  assert(ok.length === 0, "all ACTIVE publish allowed");
  assert(
    /공개할 수 없습니다/.test(
      blockedByInactiveEmploymentMessage(leaveIssues)
    ),
    "publish copy mentions 공개 차단"
  );
  const missing = missingPlacedCaddyRefs(placed, [
    { id: 2, employmentStatus: "ACTIVE" },
  ]);
  assert(
    missing.map((p) => p.id).join(",") === "1,3",
    "missing assignment and spare ids"
  );
  assert(
    /#1/.test(unknownPlacedCaddyMessage(missing)),
    "unknown caddy message includes id"
  );
}

section("휴직 → 재직 복귀 후 다시 배치 가능");
{
  const returned = house(71, { name: "복귀", employmentStatus: "LEAVE" });
  const overlaid = overlayLatestEmploymentStatus(
    [returned],
    [{ id: 71, employmentStatus: "ACTIVE" }]
  );
  assert(overlaid[0].employmentStatus === "ACTIVE", "overlay restores ACTIVE");
  assert(isAssignableCaddy(overlaid[0]), "returned caddy is assignable");
  const result = computeAutoAssignmentsV1({
    date: "2026-11-14",
    available: overlaid,
    reservations: [res("2026-11-14", "A1")],
  });
  assert(assignedIds(result).includes(71), "returned ACTIVE can be auto-assigned");
}

section("페이지·엔진 경로가 배치 가능 필터를 쓰는지");
{
  const pageSrc = readFileSync(
    join(process.cwd(), "src/app/manage/assignments/page.tsx"),
    "utf8"
  );
  const engineSrc = readFileSync(
    join(process.cwd(), "src/lib/autoAssignEngine.ts"),
    "utf8"
  );
  const draftSrc = readFileSync(
    join(process.cwd(), "src/lib/assignmentDraft.ts"),
    "utf8"
  );
  const cellSrc = readFileSync(
    join(process.cwd(), "src/lib/assignmentBoardCellEdit.ts"),
    "utf8"
  );
  const specialSrc = readFileSync(
    join(process.cwd(), "src/app/manage/assignments/SpecialDutyPanel.tsx"),
    "utf8"
  );
  const previewSrc = readFileSync(
    join(process.cwd(), "src/app/api/assignments/preview/route.ts"),
    "utf8"
  );
  const publishSrc = readFileSync(
    join(process.cwd(), "src/lib/dailyBoardPublishedService.ts"),
    "utf8"
  );
  const confirmSrc = readFileSync(
    join(process.cwd(), "src/lib/assignmentConfirmApply.ts"),
    "utf8"
  );
  const getPublishedSrc = readFileSync(
    join(process.cwd(), "src/app/api/assignments/published/route.ts"),
    "utf8"
  );
  assert(pageSrc.includes("isAssignableEmploymentStatus"), "house/pool uses assignable");
  assert(pageSrc.includes("INACTIVE_EMPLOYMENT_WARNING_CODE"), "page surfaces employment warning");
  assert(pageSrc.includes("applyLatestEmploymentToDraft"), "page overlays latest employment");
  assert(engineSrc.includes("assignableCaddiesFrom"), "engine filters assignable candidates");
  assert(draftSrc.includes("isAssignableCaddy"), "unused/manual uses assignable");
  assert(cellSrc.includes("휴직/퇴사 캐디는 배치할 수 없습니다."), "direct edit message includes 휴직");
  assert(specialSrc.includes("isAssignableEmploymentStatus"), "special duty search filters assignable");
  assert(engineSrc.includes("employmentAuthority"), "engine accepts DB employment authority");
  assert(previewSrc.includes("employmentAuthority"), "preview passes employment authority");
  assert(
    previewSrc.includes("resolveEmploymentAuthority"),
    "preview loads DB employment when client omits or sends available"
  );
  assert(
    publishSrc.includes("assertAssignableEmploymentForPublish"),
    "publish checks latest employment"
  );
  assert(
    publishSrc.includes("PUBLISH_EMPLOYMENT_LOOKUP_UNAVAILABLE_CODE"),
    "publish fail-closed when employment lookup is unavailable"
  );
  assert(
    publishSrc.includes("missingPlacedCaddyRefs"),
    "publish blocks placed ids missing from DB"
  );
  const invariantsSrc = readFileSync(
    join(process.cwd(), "src/lib/dailyBoardDraftInvariants.ts"),
    "utf8"
  );
  const loadEmploymentFn = invariantsSrc.slice(
    invariantsSrc.indexOf("export async function loadCaddyEmploymentFromDb"),
    invariantsSrc.indexOf("export function assertDailyBoardDraftInvariants")
  );
  assert(
    loadEmploymentFn.includes("catch") && loadEmploymentFn.includes("return null"),
    "employment lookup errors surface as unavailable"
  );
  assert(
    confirmSrc.includes("inactiveEmploymentIssuesFromDb"),
    "legacy confirm checks latest employment"
  );
  const getFn = getPublishedSrc.slice(
    getPublishedSrc.indexOf("export async function GET"),
    getPublishedSrc.indexOf("export async function POST")
  );
  assert(
    !getFn.includes("assertAssignableEmploymentForPublish"),
    "GET published does not rewrite or re-validate employment"
  );
}

console.log(`\nDONE: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
