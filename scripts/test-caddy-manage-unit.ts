/**
 * DB 없는 캐디 관리 유틸/스키마 단위 테스트
 * 실행: npx tsx scripts/test-caddy-manage-unit.ts
 */
import fs from "node:fs";
import path from "node:path";
import {
  employmentStatusLabel,
  isDrivingCaddyType,
  isThirdBandTeam,
  normalizeEmploymentStatus,
  countsTowardRosterHeadcount,
  rosterHeadcount,
  normalizeExtraFlags,
  normalizeTeamOrder,
  occupiesHouseThirdSlot,
  isPrimaryTeam,
  parseEmploymentFilter,
  mergeExtraFlagsForPersist,
  parseThirdBandSubgroupInput,
  resolveCaddyTypeFromTeam,
  resolveThirdBandSubgroup,
  drivingPersistFields,
  DRIVING_POOL_TEAM,
  ThirdBandSubgroupError,
  EDITABLE_EXTRA_FLAG_OPTIONS,
} from "../src/lib/caddyManage";
import { caddyCreateSchema, caddyUpdateSchema } from "../src/lib/caddySchema";

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

console.log("== caddyManage ==");
assert(normalizeEmploymentStatus("재직") === "ACTIVE", "재직→ACTIVE");
assert(normalizeEmploymentStatus("휴직") === "LEAVE", "휴직→LEAVE");
assert(normalizeEmploymentStatus("퇴사") === "RETIRED", "퇴사→RETIRED");
assert(normalizeEmploymentStatus("ACTIVE") === "ACTIVE", "ACTIVE");
assert(normalizeEmploymentStatus("LEAVE") === "LEAVE", "LEAVE");
assert(normalizeEmploymentStatus("RETIRED") === "RETIRED", "RETIRED");
assert(normalizeEmploymentStatus("retired") === "RETIRED", "retired→RETIRED");
assert(employmentStatusLabel("ACTIVE") === "재직", "label ACTIVE");
assert(employmentStatusLabel("LEAVE") === "휴직", "label LEAVE");
assert(employmentStatusLabel("RETIRED") === "퇴사", "label RETIRED");
assert(
  countsTowardRosterHeadcount("ACTIVE") === true,
  "ACTIVE counts toward 총원"
);
assert(
  countsTowardRosterHeadcount("LEAVE") === true,
  "LEAVE counts toward 총원"
);
assert(
  countsTowardRosterHeadcount("RETIRED") === false,
  "RETIRED excluded from 총원"
);
assert(
  rosterHeadcount([
    { employmentStatus: "ACTIVE" },
    { employmentStatus: "LEAVE" },
    { employmentStatus: "RETIRED" },
    { employmentStatus: "RETIRED" },
    { employmentStatus: "ACTIVE" },
  ]) === 3,
  "총원 = ACTIVE + LEAVE, RETIRED dropped"
);
assert(
  rosterHeadcount([
    ...Array.from({ length: 18 }, () => ({ employmentStatus: "ACTIVE" })),
    { employmentStatus: "LEAVE" },
    ...Array.from({ length: 5 }, () => ({ employmentStatus: "RETIRED" })),
  ]) === 19,
  "example: ACTIVE 18 + LEAVE 1 + RETIRED 5 → 총 19"
);
assert(parseEmploymentFilter("재직") === "ACTIVE", "filter 재직");
assert(parseEmploymentFilter("all") === "all", "filter all");
assert(parseEmploymentFilter("RETIRED") === "RETIRED", "filter RETIRED");
assert(normalizeTeamOrder(-3) === 0, "teamOrder floor at 0");
assert(normalizeTeamOrder(2.9) === 2, "teamOrder int");
assert(
  JSON.stringify(normalizeExtraFlags(["주중반", "dummy", "드라이빙", "주중반"])) ===
    JSON.stringify(["주중반", "드라이빙"]),
  "extraFlags normalize"
);

console.log("== caddySchema ==");
const created = caddyCreateSchema.safeParse({
  name: "홍길동",
  team: "3조",
  teamOrder: 2,
  extraFlags: ["주말반"],
});
assert(created.success, "create schema ok");
assert(
  created.success && created.data.employmentStatus === "ACTIVE",
  "default ACTIVE"
);
assert(created.success && created.data.teamOrder === 2, "create teamOrder set");

const createdKo = caddyCreateSchema.safeParse({
  name: "홍길동",
  team: "3조",
  teamOrder: 1,
  employmentStatus: "퇴사",
});
assert(
  createdKo.success && createdKo.data.employmentStatus === "RETIRED",
  "create accepts 한글 퇴사→RETIRED"
);

const bad = caddyCreateSchema.safeParse({ name: "", team: "1조", teamOrder: 1 });
assert(!bad.success, "reject empty name");

const noSlot = caddyCreateSchema.safeParse({ name: "홍길동", team: "1조" });
assert(!noSlot.success, "reject missing teamOrder");

const drivingCreate = caddyCreateSchema.safeParse({
  name: "드라이브",
  caddyType: "DRIVING",
});
assert(drivingCreate.success, "DRIVING create without team/slot");
assert(
  drivingCreate.success && drivingCreate.data.caddyType === "DRIVING",
  "create keeps DRIVING type"
);

assert(isDrivingCaddyType("DRIVING"), "isDrivingCaddyType");
assert(!occupiesHouseThirdSlot({ caddyType: "DRIVING", team: "1조" }), "DRIVING skips slot");
assert(
  !occupiesHouseThirdSlot({ caddyType: "HOUSE", team: DRIVING_POOL_TEAM }),
  "드라이빙 조 skips slot"
);
assert(
  occupiesHouseThirdSlot({ caddyType: "HOUSE", team: "1조" }),
  "HOUSE occupies slot"
);
assert(
  !occupiesHouseThirdSlot({ caddyType: "HOUSE", team: "주중반" }),
  "extra-flag team is not a 1~12 slot"
);
assert(isPrimaryTeam("12조") && !isPrimaryTeam("드라이빙"), "primary teams only 1~12");
assert(drivingPersistFields().teamOrder === 0, "driving teamOrder 0");
assert(drivingPersistFields().team === DRIVING_POOL_TEAM, "driving pool team");

const updated = caddyUpdateSchema.safeParse({
  teamOrder: 5,
  employmentStatus: "LEAVE",
  extraFlags: ["드라이빙"],
});
assert(updated.success, "update schema ok");
assert(
  updated.success && updated.data.employmentStatus === "LEAVE",
  "update LEAVE"
);

assert(
  created.success && created.data.employeeCode === undefined,
  "create omits employeeCode by default"
);
assert(
  created.success && created.data.caddyType === undefined,
  "create omits caddyType by default"
);
assert(
  created.success && created.data.missingFromImport === undefined,
  "create omits missingFromImport by default"
);

console.log("== caddyType from team ==");
assert(resolveCaddyTypeFromTeam("1조") === "HOUSE", "1조 → HOUSE");
assert(resolveCaddyTypeFromTeam("8조") === "HOUSE", "8조 → HOUSE");
assert(resolveCaddyTypeFromTeam("9조") === "THIRD", "9조 → THIRD");
assert(resolveCaddyTypeFromTeam("10조") === "THIRD", "10조 → THIRD");
assert(resolveCaddyTypeFromTeam("12조") === "THIRD", "12조 → THIRD");
assert(
  resolveCaddyTypeFromTeam("8조") === "HOUSE" &&
    resolveCaddyTypeFromTeam("9조") === "THIRD",
  "8→9 이동 시 THIRD"
);
assert(
  resolveCaddyTypeFromTeam("9조") === "THIRD" &&
    resolveCaddyTypeFromTeam("8조") === "HOUSE",
  "9→8 이동 시 HOUSE"
);

console.log("== thirdBandSubgroup ==");
assert(isThirdBandTeam("9조") && isThirdBandTeam("12조"), "9~12 are third band");
assert(!isThirdBandTeam("1조") && !isThirdBandTeam("8조"), "1~8 not third band");
assert(parseThirdBandSubgroupInput(undefined) === undefined, "parse omit");
assert(parseThirdBandSubgroupInput(null) === null, "parse null");
assert(parseThirdBandSubgroupInput("일반") === null, "parse 일반");
assert(parseThirdBandSubgroupInput("WEEKDAY") === "WEEKDAY", "parse WEEKDAY");
assert(parseThirdBandSubgroupInput("주말") === "WEEKEND", "parse 주말");

assert(
  resolveThirdBandSubgroup({ team: "9조", requested: "WEEKDAY" }) === "WEEKDAY",
  "9조 + WEEKDAY"
);
assert(
  resolveThirdBandSubgroup({ team: "10조", requested: "WEEKEND" }) === "WEEKEND",
  "10조 + WEEKEND"
);
assert(
  resolveThirdBandSubgroup({ team: "11조", requested: null }) === null,
  "11조 + null"
);
assert(
  resolveThirdBandSubgroup({ team: "12조", requested: undefined, current: null }) ===
    null,
  "12조 omit → null"
);

try {
  resolveThirdBandSubgroup({ team: "1조", requested: "WEEKDAY" });
  assert(false, "1조 + WEEKDAY must throw");
} catch (e) {
  assert(
    e instanceof ThirdBandSubgroupError,
    "1조 + WEEKDAY → ThirdBandSubgroupError"
  );
}
try {
  resolveThirdBandSubgroup({ team: "8조", requested: "WEEKEND" });
  assert(false, "8조 + WEEKEND must throw");
} catch (e) {
  assert(
    e instanceof ThirdBandSubgroupError,
    "8조 + WEEKEND → ThirdBandSubgroupError"
  );
}

assert(
  resolveThirdBandSubgroup({
    team: "3조",
    requested: undefined,
    current: "WEEKDAY",
  }) === null,
  "9~12→1~8: omit still clears to null"
);
assert(
  resolveThirdBandSubgroup({
    team: "9조",
    requested: undefined,
    current: null,
  }) === null,
  "1~8→9~12: no auto WEEKDAY/WEEKEND (null)"
);
assert(
  resolveThirdBandSubgroup({
    team: "9조",
    requested: undefined,
    current: "WEEKDAY",
  }) === "WEEKDAY",
  "9→9 omit keeps WEEKDAY"
);

const create9 = caddyCreateSchema.safeParse({
  name: "삼부",
  team: "9조",
  teamOrder: 1,
  thirdBandSubgroup: "WEEKDAY",
});
assert(
  create9.success && create9.data.thirdBandSubgroup === "WEEKDAY",
  "create schema accepts 9조 WEEKDAY"
);
const create10 = caddyCreateSchema.safeParse({
  name: "주말",
  team: "10조",
  teamOrder: 1,
  thirdBandSubgroup: "WEEKEND",
});
assert(
  create10.success && create10.data.thirdBandSubgroup === "WEEKEND",
  "create schema accepts 10조 WEEKEND"
);
const updateNull = caddyUpdateSchema.safeParse({
  team: "11조",
  thirdBandSubgroup: null,
});
assert(
  updateNull.success && updateNull.data.thirdBandSubgroup === null,
  "update schema accepts null"
);

console.log("== legacy extraFlags 보존 / 신규 이중입력 차단 ==");
{
  const preserved = mergeExtraFlagsForPersist({
    incoming: ["드라이빙"],
    current: ["주중반", "드라이빙"],
    mode: "update",
  });
  assert(
    JSON.stringify(preserved) === JSON.stringify(["주중반", "드라이빙"]),
    "edit save: 주중반+기타(드라이빙) 보존"
  );

  const weekendOnly = mergeExtraFlagsForPersist({
    incoming: [],
    current: ["주말반"],
    mode: "update",
  });
  assert(
    JSON.stringify(weekendOnly) === JSON.stringify(["주말반"]),
    "other fields only: 주말반 보존"
  );

  const weekdayPlusOther = mergeExtraFlagsForPersist({
    incoming: ["드라이빙"],
    current: ["주중반", "기타무시됨"],
    mode: "update",
  });
  assert(
    weekdayPlusOther.includes("주중반") && weekdayPlusOther.includes("드라이빙"),
    "주중반+기타값(편집가능) 보존"
  );

  const createWeekdayLeak = mergeExtraFlagsForPersist({
    incoming: ["주중반", "드라이빙"],
    mode: "create",
  });
  assert(
    JSON.stringify(createWeekdayLeak) === JSON.stringify(["드라이빙"]),
    "create: 주중반 신규 추가 차단, 드라이빙만"
  );

  const createWeekendLeak = mergeExtraFlagsForPersist({
    incoming: ["주말반"],
    mode: "create",
  });
  assert(
    JSON.stringify(createWeekendLeak) === JSON.stringify([]),
    "create: 주말반 신규 추가 차단"
  );

  // UI: 주중/주말 선택 → thirdBandSubgroup만 (extraFlags 자동 추가 없음)
  const uiCreateWeekdayFlags = mergeExtraFlagsForPersist({
    incoming: [],
    mode: "create",
  });
  assert(
    uiCreateWeekdayFlags.length === 0 &&
      resolveThirdBandSubgroup({ team: "9조", requested: "WEEKDAY" }) ===
        "WEEKDAY",
    "신규 주중 → WEEKDAY only, extraFlags에 주중반 없음"
  );
  assert(
    mergeExtraFlagsForPersist({ incoming: [], mode: "create" }).length === 0 &&
      resolveThirdBandSubgroup({ team: "10조", requested: "WEEKEND" }) ===
        "WEEKEND",
    "신규 주말 → WEEKEND only, extraFlags에 주말반 없음"
  );

  assert(
    resolveThirdBandSubgroup({
      team: "1조",
      requested: undefined,
      current: "WEEKDAY",
    }) === null,
    "9~12→1~8: thirdBandSubgroup null"
  );

  assert(
    JSON.stringify(EDITABLE_EXTRA_FLAG_OPTIONS) ===
      JSON.stringify(["드라이빙"]),
    "UI editable extraFlags = 드라이빙 only"
  );

  const uiSrc = fs.readFileSync(
    path.resolve("src/app/manage/caddies/page.tsx"),
    "utf8"
  );
  assert(
    /EDITABLE_EXTRA_FLAG_OPTIONS\.map/.test(uiSrc) &&
      !/\bEXTRA_FLAG_OPTIONS\.map/.test(uiSrc) &&
      !/checked=\{[^}]*주중반/.test(uiSrc),
    "manage UI maps EDITABLE flags only (no 주중반/주말반 checkbox)"
  );
  assert(
    /드라이빙 캐디 등록/.test(uiSrc) && /createKind === 'driving'/.test(uiSrc),
    "manage UI has dedicated driving create"
  );
}

console.log("== manage toast sits above bottom nav ==");
{
  const css = fs.readFileSync(path.resolve("src/app/globals.css"), "utf8");
  assert(/--vh-toast-z:\s*60/.test(css), "toast z-index above bottom tabs 35");
  assert(
    /--vh-bottom-nav-height:\s*58px/.test(css) &&
      /env\(safe-area-inset-bottom/.test(css),
    "toast offset includes nav height and safe-area"
  );
  assert(
    /z-index:\s*var\(--vh-toast-z\)\s*!important/.test(css),
    "toast z-index beats local styled rules"
  );
}

console.log("== swap B auto-preview source ==");
{
  const panel = fs.readFileSync(
    path.resolve("src/app/manage/assignments/LiveChangePanel.tsx"),
    "utf8"
  );
  const board = fs.readFileSync(
    path.resolve("src/app/manage/assignments/page.tsx"),
    "utf8"
  );
  assert(/function previewSwap\(/.test(panel), "panel previewSwap helper");
  assert(
    /changeType !== "SWAP_CADDY"/.test(panel),
    "SWAP skips 배치 다시 맞추기 button"
  );
  assert(
    /useState\(false\)/.test(panel) &&
      /기타 배치 설정/.test(panel) &&
      /aria-expanded=\{advancedOpen\}/.test(panel),
    "advanced live-change form starts collapsed"
  );
  assert(
    !/setAdvancedOpen\(true\)/.test(panel),
    "Quick Action preset does not auto-open advanced form"
  );
  assert(
    /예약 취소/.test(panel) &&
      /TEAM_NOSHOW/.test(panel) &&
      /CADDY_ATTENDANCE_NOSHOW/.test(panel) &&
      /순번 바꿈/.test(panel),
    "Quick Action labels remain"
  );
  assert(
    /if \(swapKey\) \{\s*onSwapClick\(row\)/.test(board) &&
      /const change: LiveChangeInput = \{\s*type: "SWAP_CADDY",\s*reservationKeyA: swapKey,\s*reservationKeyB: key,?\s*\}/.test(
        board
      ) &&
      /void applyQuickChange\(change\)/.test(board),
    "board B tap applies SWAP_CADDY via LiveChangeInput"
  );
}

console.log("== 당추 추가는 미리보기 흐름, 빈 칸 클릭/현재 부 기본값 ==");
{
  const panel = fs.readFileSync(
    path.resolve("src/app/manage/assignments/LiveChangePanel.tsx"),
    "utf8"
  );
  const board = fs.readFileSync(
    path.resolve("src/app/manage/assignments/page.tsx"),
    "utf8"
  );
  const engine = fs.readFileSync(
    path.resolve("src/lib/autoAssignEngine.ts"),
    "utf8"
  );
  const change = fs.readFileSync(
    path.resolve("src/lib/assignmentChange.ts"),
    "utf8"
  );
  assert(
    /cell\.kind === "empty"/.test(board) &&
      /<button/.test(board) &&
      /className=\{`bc-cell empty \$\{/.test(board) &&
      /moveDest \? "move-dest" : "addable"/.test(board) &&
      /onEmptyBoardCellClick\(code, tr\.teeTime\)/.test(board) &&
      /function onEmptyBoardCellClick/.test(board) &&
      /changeFromEmptyBoardCell\(/.test(board) &&
      /teamName: "당추"/.test(board) &&
      /당추를 추가할까요\?/.test(board) &&
      /setLiveChangePreset\(change\)/.test(board),
    "empty board cell is clickable 당추 추가"
  );
  assert(
    /당추 추가/.test(board) && /SameDayAddSheet/.test(board),
    "per-shift 당추 추가 button + sheet"
  );
  assert(
    /defaultShift=\{shiftTab\}/.test(board) &&
      /useState<ShiftPart>\(defaultShift\)/.test(panel),
    "당추 추가 부 기본값은 현재 탭"
  );
  assert(
    /setLiveChangePreset/.test(board) &&
      /preset=\{liveChangePreset\}/.test(board) &&
      /onApplyPreview=\{onLiveApply\}/.test(board),
    "당추 uses LiveChange preview/apply, not instant save"
  );
  assert(
    /const canApply = !!preview && !applying && !blockingError/.test(panel),
    "Apply disabled on blocking errors"
  );
  assert(
    /level: "error"/.test(engine) &&
      /code: "DUPLICATE_COURSE_TEETIME"/.test(engine) &&
      /해당 코스\/티타임에 이미 예약이 있습니다/.test(engine) &&
      /continue;/.test(engine),
    "duplicate course/teeTime is engine hard error and does not insert"
  );
  assert(
    /hasBlockingLiveChangeError/.test(change) &&
      /makeAddReservationChange/.test(change),
    "shared ADD_RESERVATION helpers"
  );
}

console.log("== ops menu simplify: one place per daily action ==");
{
  const panel = fs.readFileSync(
    path.resolve("src/app/manage/assignments/LiveChangePanel.tsx"),
    "utf8"
  );
  const board = fs.readFileSync(
    path.resolve("src/app/manage/assignments/page.tsx"),
    "utf8"
  );
  const change = fs.readFileSync(
    path.resolve("src/lib/assignmentChange.ts"),
    "utf8"
  );
  const sheet = panel.split("export function BoardQuickSheet")[1] || "";
  const teamActions =
    sheet.split("qa-team-actions")[1]?.split("qa-caddy-actions")[0] || "";
  const caddyActions =
    sheet.split("qa-caddy-actions")[1]?.split("function MovePreviewBlock")[0] ||
    "";
  const advancedBlock =
    panel.split("{advancedOpen && (")[1]?.split("{error &&")[0] || "";

  assert(
    /\$\{teamName\} 팀/.test(sheet) && /className="qa-title"/.test(sheet),
    "team click title is '{name} 팀'"
  );
  assert(
    /팀 이동/.test(teamActions) &&
      /예약 취소/.test(teamActions) &&
      />\s*노쇼\s*</.test(teamActions) &&
      /리무진/.test(teamActions) &&
      /드라이빙/.test(teamActions) &&
      /SET_LOCK/.test(teamActions) &&
      /LOCK ON/.test(teamActions),
    "team menu exposes move/cancel/noshow/limo/driving/LOCK"
  );
  assert(
    /CADDY_SICK/.test(caddyActions) &&
      /CADDY_ATTENDANCE_NOSHOW/.test(caddyActions) &&
      /순번 바꿈/.test(caddyActions) &&
      />\s*병가\s*</.test(caddyActions) &&
      />\s*결근\s*</.test(caddyActions),
    "caddy menu exposes sick/noshow/swap"
  );
  assert(
    !/SET_LOCK/.test(caddyActions) && !/LOCK ON/.test(caddyActions),
    "caddy menu does not expose LOCK"
  );
  assert(
    /기타 배치 설정/.test(panel) &&
      /일상 작업은 보드에서/.test(advancedBlock) &&
      /LIVE_CHANGE_TYPES\.map/.test(advancedBlock) &&
      /function buildChange\(/.test(panel),
    "daily types stay in collapsed diagnostic form, handlers not deleted"
  );
  assert(
    /export const LIVE_CHANGE_TYPES/.test(change) &&
      /MOVE_RESERVATION/.test(change) &&
      /ADD_RESERVATION/.test(change) &&
      /SET_LOCK/.test(change),
    "LiveChange types/API unchanged"
  );
  assert(
    /당추 추가/.test(board) &&
      /SameDayAddSheet/.test(board) &&
      /onEmptyBoardCellClick/.test(board) &&
      /ops-date-settings/.test(board) &&
      /날짜 설정 \(당번·마샬, 특수근무, 코스\)/.test(board),
    "당추 entry points and date settings remain"
  );

  const firstCaddyAt = board.indexOf("오늘 1부 첫 캐디");
  const dateSettingsAt = board.indexOf("날짜 설정 (당번·마샬, 특수근무, 코스)");
  const dutyAt = board.indexOf("당번·마샬·조장 Excel");
  const livePanelAt = board.indexOf("<LiveChangePanel");
  const boardToolsAt = board.indexOf("ops-board-tools");
  assert(
    firstCaddyAt > 0 &&
      dateSettingsAt > firstCaddyAt &&
      dutyAt > dateSettingsAt &&
      boardToolsAt > 0 &&
      livePanelAt > boardToolsAt,
    "first screen: date/caddy/run before date settings; 기타 after board"
  );
  assert(
    /min-height:\s*48px/.test(board) && /className="qa-title"/.test(panel),
    "mobile sheet buttons and titles are large enough"
  );
}

console.log("== POST schedule/shifts exclude RETIRED only ==");
{
  const schedule = fs.readFileSync(
    path.resolve("src/app/api/schedule/route.ts"),
    "utf8"
  );
  const shifts = fs.readFileSync(
    path.resolve("src/app/api/shifts/route.ts"),
    "utf8"
  );
  const schedulePost = schedule.split("export async function POST")[1] || "";
  const scheduleGet = schedule.split("export async function POST")[0] || "";
  const shiftsPost = shifts.split("export async function POST")[1] || "";
  const shiftsGet = shifts.split("export async function POST")[0] || "";

  assert(
    /employmentStatus:\s*\{\s*not:\s*['"]RETIRED['"]\s*\}/.test(schedulePost),
    "POST /api/schedule findMany excludes RETIRED"
  );
  assert(
    /employmentStatus:\s*\{\s*not:\s*['"]RETIRED['"]\s*\}/.test(shiftsPost),
    "POST /api/shifts findMany excludes RETIRED"
  );
  assert(
    !/employmentStatus:\s*['"]ACTIVE['"]/.test(schedulePost) &&
      !/notIn:\s*\[[^\]]*LEAVE/.test(schedulePost),
    "POST /api/schedule does not change LEAVE policy"
  );
  assert(
    !/employmentStatus:\s*['"]ACTIVE['"]/.test(shiftsPost) &&
      !/notIn:\s*\[[^\]]*LEAVE/.test(shiftsPost),
    "POST /api/shifts does not change LEAVE policy"
  );
  assert(
    !/employmentStatus:\s*\{\s*not:\s*['"]RETIRED['"]\s*\}/.test(scheduleGet),
    "GET /api/schedule does not filter RETIRED (past lookup unchanged)"
  );
  assert(
    !/employmentStatus:\s*\{\s*not:\s*['"]RETIRED['"]\s*\}/.test(shiftsGet),
    "GET /api/shifts does not filter RETIRED (past lookup unchanged)"
  );
  assert(
    !/prisma\.caddy\.delete(Many)?\s*\(/.test(schedule) &&
      !/prisma\.caddy\.delete(Many)?\s*\(/.test(shifts),
    "schedule/shifts routes have no caddy hard-delete"
  );
}

console.log("== 총원 excludes RETIRED (source) ==");
{
  const caddiesPage = fs.readFileSync(
    path.resolve("src/app/manage/caddies/page.tsx"),
    "utf8"
  );
  const dash = fs.readFileSync(path.resolve("src/app/manage/page.tsx"), "utf8");
  assert(
    caddiesPage.includes("rosterHeadcount") &&
      caddiesPage.includes("countsTowardRosterHeadcount") &&
      caddiesPage.includes("총원 {rosterCounts.headcount}명"),
    "caddies page 총원 uses ACTIVE+LEAVE helper"
  );
  assert(
    caddiesPage.includes("drivingHeadcount") &&
      caddiesPage.includes("countsTowardRosterHeadcount(r.employmentStatus)) cur.total"),
    "한눈에 조별/드라이빙 총원 excludes RETIRED"
  );
  assert(
    /employmentStatus:\s*\{\s*in:\s*\["ACTIVE",\s*"LEAVE"\]\s*\}/.test(dash),
    "dashboard 총 캐디 KPI excludes RETIRED"
  );
  assert(
    dash.includes('if (st === "ACTIVE" || st === "LEAVE") bucket.total += 1'),
    "dashboard 한눈에 조별 총원 excludes RETIRED"
  );
  assert(
    !fs.existsSync(path.resolve("src/app/api/caddies/[id]/hard-delete/route.ts")),
    "no generic hard-delete API added"
  );
}

console.log("== caddies roster board UI source ==");
{
  const src = fs.readFileSync(
    path.resolve("src/app/manage/caddies/page.tsx"),
    "utf8"
  );
  const rosterBlock =
    src.split("const rosterColumns = useMemo")[1]?.split("function startEdit")[0] ||
    "";
  const sheetBlock = src.split("{menuCaddy && (")[1]?.split("<style>{`")[0] || "";
  assert(/className="cm-roster"/.test(src), "default view is horizontal roster");
  assert(
    /GLANCE_TEAMS\.map\(\(team\) =>/.test(rosterBlock) &&
      /a\.teamOrder - b\.teamOrder/.test(rosterBlock),
    "roster columns are 1~12조 sorted by teamOrder"
  );
  assert(
    /normalizeEmploymentStatus\(r\.employmentStatus\) !== 'RETIRED'/.test(
      rosterBlock
    ),
    "RETIRED hidden from default roster"
  );
  assert(
    /leave \? \(\s*<span className="cm-leave-badge">휴직<\/span>/.test(src) ||
      /cm-leave-badge">휴직/.test(src),
    "LEAVE keeps slot with 휴직 badge"
  );
  assert(
    /setMenuCaddyId\(c\.id\)/.test(src) &&
      />\s*수정\s*</.test(sheetBlock) &&
      /조\/순번 변경/.test(sheetBlock) &&
      />\s*휴직\s*</.test(sheetBlock) &&
      /드라이빙 전환/.test(sheetBlock) &&
      />\s*삭제\s*</.test(sheetBlock) &&
      />\s*복귀\s*</.test(sheetBlock),
    "name click opens status-aware manage menu"
  );
  assert(
    /function convertToDriving\(c: Caddy\)/.test(src) &&
      /method: 'PATCH'/.test(src) &&
      /employmentStatus: status/.test(src) &&
      /caddyType: 'DRIVING'/.test(src) &&
      /function saveEdit\(id: number\)/.test(src),
    "menu reuses existing PATCH save/leave/return/driving APIs"
  );
  assert(
    /신규 등록/.test(src) &&
      /상세 관리/.test(src) &&
      /명단 가져오기/.test(src) &&
      /명단 Export/.test(src) &&
      /\/api\/caddies\/export/.test(src) &&
      /createKind === 'driving'/.test(src) &&
      /cm-detail-tools/.test(src),
    "create/import/export remain reachable from 상세 관리"
  );
  assert(
    /min-width:\s*168px/.test(src) &&
      /overflow-x:\s*auto/.test(src) &&
      /position:\s*sticky/.test(src) &&
      /min-height:\s*44px/.test(src),
    "mobile roster has min column width, horizontal scroll, sticky headers"
  );
  assert(
    /rosterPersonName\(c\)/.test(src) &&
      !/cm-cell-name[\s\S]{0,40}\{c\.id\}/.test(src) &&
      !/cm-ord[\s\S]{0,40}\{c\.id\}/.test(src),
    "roster cell does not render caddyId"
  );
}

console.log("== soft-delete API source guard ==");
const apiFiles = [
  "src/app/api/caddies/route.ts",
  "src/app/api/caddies/[id]/route.ts",
];
for (const rel of apiFiles) {
  const src = fs.readFileSync(path.resolve(rel), "utf8");
  assert(
    !/prisma\.caddy\.delete(Many)?\s*\(/.test(src),
    `${rel} has no caddy hard-delete`
  );
  assert(
    src.includes('employmentStatus: "RETIRED"'),
    `${rel} soft-retires with RETIRED`
  );
  assert(
    src.includes("resolveCaddyTypeFromTeam"),
    `${rel} forces caddyType from team`
  );
}

console.log(`\nDONE: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
