/**
 * 특수지원 v1 단위 테스트 (DB 없음)
 * 실행: npx tsx scripts/test-daily-special-support-unit.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  computeAutoAssignmentsV1,
  REASON,
  reflowRegularAssignments,
  reservationKey,
  type AutoAssignCaddy,
  type AutoAssignReservation,
} from "../src/lib/autoAssignEngine";
import { createDraftFromAutoResult as draftFromResult } from "../src/lib/assignmentDraft";
import {
  buildPublishedPayloadFromDraft,
} from "../src/lib/dailyBoardPublished";
import { assignmentDraftToPayload } from "../src/lib/dailyBoardDraft";
import {
  emptySpecialSupportByShift,
  hasHardExclusionReason,
  isEligibleSpecialSupportCandidate,
  isHardExcludedSpecialSupport,
} from "../src/lib/dailySpecialSupport";
import { boardAssignmentMarks } from "../src/lib/assignmentBoardView";

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

function house(id: number, order: number): AutoAssignCaddy {
  return {
    id,
    name: `H${id}`,
    team: "1조",
    teamOrder: order,
    caddyType: "HOUSE",
    employmentStatus: "ACTIVE",
  };
}

function third(id: number, order: number): AutoAssignCaddy {
  return {
    id,
    name: `T${id}`,
    team: "9조",
    teamOrder: order,
    caddyType: "THIRD",
    employmentStatus: "ACTIVE",
  };
}

function supportCaddy(id: number, name: string, team = "7조"): AutoAssignCaddy {
  return {
    id,
    name,
    team,
    teamOrder: 1,
    caddyType: "HOUSE",
    employmentStatus: "ACTIVE",
  };
}

function res(
  date: string,
  shift: "1부" | "2부" | "3부",
  tee: string,
  course: "VERTHILL" | "SKY" | "OCEAN" | "LAKE",
  i: number
): AutoAssignReservation {
  return {
    date,
    course,
    courseLabel: course,
    shift,
    teeTime: tee,
    teamName: `${shift}-${course}-${i}`,
    rawRowIndex: i,
  };
}

function shiftRes(
  date: string,
  shift: "1부" | "2부" | "3부",
  count: number,
  teeStart = "06:00"
): AutoAssignReservation[] {
  const courses = ["VERTHILL", "SKY", "OCEAN", "LAKE"] as const;
  const [hh, mm] = teeStart.split(":").map(Number);
  const out: AutoAssignReservation[] = [];
  for (let i = 0; i < count; i++) {
    const total = hh * 60 + mm + Math.floor(i / 4) * 7;
    const h = String(Math.floor(total / 60) % 24).padStart(2, "0");
    const m = String(total % 60).padStart(2, "0");
    out.push(res(date, shift, `${h}:${m}`, courses[i % 4], i + 1));
  }
  return out;
}

function readSrc(rel: string) {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

section("hard exclusion");
{
  assert(isHardExcludedSpecialSupport({ employmentStatus: "LEAVE" }), "LEAVE 차단");
  assert(isHardExcludedSpecialSupport({ employmentStatus: "RETIRED" }), "RETIRED 차단");
  assert(isHardExcludedSpecialSupport({ excludedReasons: ["병가"] }), "병가 차단");
  assert(isHardExcludedSpecialSupport({ excludedReasons: ["결근"] }), "결근 차단");
  assert(isHardExcludedSpecialSupport({ excludedReasons: ["장기병가"] }), "장기병가 차단");
  assert(
    isHardExcludedSpecialSupport({
      employmentStatus: "ACTIVE",
      excludedReasons: ["휴무", "병가"],
    }),
    "겹치면 hard exclusion 우선"
  );
  assert(
    isEligibleSpecialSupportCandidate({
      id: 1,
      name: "휴무자",
      team: "7조",
      employmentStatus: "ACTIVE",
      excludedReasons: ["휴무"],
    }),
    "휴무자는 지원 가능"
  );
  assert(
    isEligibleSpecialSupportCandidate({
      id: 2,
      name: "마샬",
      team: "9조",
      employmentStatus: "ACTIVE",
      excludedReasons: ["조출마샬"],
    }),
    "마샬은 지원 가능"
  );
  assert(
    !isEligibleSpecialSupportCandidate({
      id: 3,
      name: "병가",
      team: "1조",
      employmentStatus: "ACTIVE",
      excludedReasons: ["병가"],
    }),
    "병가는 목록에서 제외"
  );
  assert(hasHardExclusionReason(["미출근"]), "미출근 hard");
}

section("휴무자 1부 지원은 정상 후보 뒤에만");
{
  const date = "2026-08-26";
  const available = [house(1, 1), house(2, 2), house(3, 3)];
  const off = supportCaddy(90, "휴무지원");
  const reservations = [
    ...shiftRes(date, "1부", 3),
    ...shiftRes(date, "1부", 1, "06:21").map((r, i) => ({
      ...r,
      rawRowIndex: 40 + i,
      teamName: "extra-1",
    })),
  ];
  const without = computeAutoAssignmentsV1({
    date,
    available,
    reservations,
  });
  const withSupport = computeAutoAssignmentsV1({
    date,
    available,
    reservations,
    specialSupportByShift: { ...emptySpecialSupportByShift(), "1부": [off] },
  });
  const s1Without = without.assignments.filter((a) => a.shift === "1부");
  const s1With = withSupport.assignments.filter((a) => a.shift === "1부");
  assert(s1Without.length === 3, "지원 없으면 정상 3명만");
  assert(s1With.length === 4, "지원 있으면 4번째 메움");
  assert(
    s1With.slice(0, 3).every((a) => a.kind === "regular"),
    "앞 3자리는 정상"
  );
  const tail = s1With[3];
  assert(tail.kind === "specialSupport" && tail.caddy.id === 90, "마지막만 휴무 지원");
  assert(tail.reason === REASON.SPECIAL_SUPPORT, "SPECIAL_SUPPORT reason");
  assert(tail.locked === false, "지원은 LOCK 아님");
}

section("마샬 3부 지원 / 조장·당번 특정 부 / 여러 부");
{
  const date = "2026-08-26";
  const available = [house(1, 1), house(2, 2), third(11, 1)];
  const marshal = supportCaddy(91, "마샬지원", "9조");
  const leader = supportCaddy(92, "조장지원", "8조");
  const duty = supportCaddy(93, "당번지원", "6조");
  const reservations = [
    ...shiftRes(date, "1부", 3),
    ...shiftRes(date, "2부", 3),
    ...shiftRes(date, "3부", 5),
  ];
  const result = computeAutoAssignmentsV1({
    date,
    available,
    reservations,
    specialSupportByShift: {
      "1부": [duty],
      "2부": [leader],
      "3부": [marshal, leader],
    },
  });
  const byShiftKind = (shift: "1부" | "2부" | "3부") =>
    result.assignments.filter((a) => a.shift === shift && a.kind === "specialSupport");
  assert(byShiftKind("1부").every((a) => a.caddy.id === 93), "1부 당번 지원");
  assert(byShiftKind("2부").every((a) => a.caddy.id === 92), "2부 조장 지원");
  assert(
    byShiftKind("3부").some((a) => a.caddy.id === 91),
    "3부 마샬 지원"
  );
  assert(
    result.assignments.filter((a) => a.caddy.id === 92).length >= 2,
    "조장은 여러 부 지원 가능"
  );
}

section("정상 가용 복귀 시 중복 없음");
{
  const date = "2026-08-26";
  const back = house(5, 5);
  const result = computeAutoAssignmentsV1({
    date,
    available: [house(1, 1), house(2, 2), back],
    reservations: shiftRes(date, "1부", 3),
    specialSupportByShift: { ...emptySpecialSupportByShift(), "1부": [back] },
  });
  const ids = result.assignments.filter((a) => a.shift === "1부").map((a) => a.caddy.id);
  assert(ids.filter((id) => id === 5).length === 1, "같은 부 한 번만");
  assert(
    result.assignments.every((a) => a.caddy.id !== 5 || a.kind === "regular"),
    "정상 가용이면 지원 overlay 무시"
  );
}

section("지원자 때문에 다음 부 normal cursor가 변하지 않음");
{
  const date = "2026-08-26";
  const available = [house(1, 1), house(2, 2), house(3, 3)];
  const off = supportCaddy(90, "휴무지원");
  const baseRes = [...shiftRes(date, "1부", 3), ...shiftRes(date, "2부", 3)];
  const extra = res(date, "1부", "06:28", "VERTHILL", 99);
  const without = computeAutoAssignmentsV1({
    date,
    available,
    reservations: baseRes,
  });
  const withSupport = computeAutoAssignmentsV1({
    date,
    available,
    reservations: [...baseRes, extra],
    specialSupportByShift: { ...emptySpecialSupportByShift(), "1부": [off] },
  });
  const first2Without = without.assignments.find((a) => a.shift === "2부")?.caddy.id;
  const first2With = withSupport.assignments.find((a) => a.shift === "2부")?.caddy.id;
  assert(first2Without === first2With, "2부 첫 정상 캐디 동일");
  assert(
    withSupport.assignments.some(
      (a) => a.shift === "1부" && a.kind === "specialSupport" && a.caddy.id === 90
    ),
    "1부 extra는 지원자가 메움"
  );
}

section("지원자 때문에 THIRD cursor가 변하지 않음");
{
  const date = "2026-08-26";
  const available = [
    house(1, 1),
    house(2, 2),
    house(3, 3),
    house(4, 4),
    third(11, 1),
    third(12, 2),
  ];
  const marshal = supportCaddy(91, "마샬3부", "9조");
  const reservations = [
    ...shiftRes(date, "1부", 2),
    ...shiftRes(date, "2부", 2),
    ...shiftRes(date, "3부", 3),
  ];
  const without = computeAutoAssignmentsV1({ date, available, reservations });
  const extras = shiftRes(date, "3부", 4, "16:00").map((r, i) => ({
    ...r,
    rawRowIndex: 80 + i,
    teamName: `extra-3-${i}`,
  }));
  const withSupport = computeAutoAssignmentsV1({
    date,
    available,
    reservations: [...reservations, ...extras],
    specialSupportByShift: { ...emptySpecialSupportByShift(), "3부": [marshal] },
  });
  const thirdWithout = without.assignments
    .filter((a) => a.shift === "3부" && a.caddy.id === 11)
    .map((a) => a.reservation.teeTime);
  const thirdWith = withSupport.assignments
    .filter((a) => a.shift === "3부" && a.caddy.id === 11)
    .map((a) => a.reservation.teeTime);
  assert(thirdWithout.join() === thirdWith.join(), "regular THIRD 자리 동일");
  assert(
    withSupport.assignments.some(
      (a) => a.shift === "3부" && a.kind === "specialSupport"
    ),
    "남은 3부는 지원"
  );
}

section("지원자는 정상 스페어를 밀어내지 않음");
{
  const date = "2026-08-26";
  const available = [house(1, 1), house(2, 2), house(3, 3), house(4, 4), house(5, 5)];
  const off = supportCaddy(90, "휴무지원");
  const reservations = shiftRes(date, "1부", 3);
  const without = computeAutoAssignmentsV1({ date, available, reservations });
  const withSupport = computeAutoAssignmentsV1({
    date,
    available,
    reservations,
    specialSupportByShift: { ...emptySpecialSupportByShift(), "1부": [off] },
  });
  const spWithout = without.sparesByShift.find((s) => s.shift === "1부");
  const spWith = withSupport.sparesByShift.find((s) => s.shift === "1부");
  assert(spWithout?.spare1?.caddyId === spWith?.spare1?.caddyId, "spare1 동일");
  assert(spWithout?.spare2?.caddyId === spWith?.spare2?.caddyId, "spare2 동일");
  assert(spWith?.spare1?.caddyId !== 90 && spWith?.spare2?.caddyId !== 90, "지원자는 spare 아님");
  assert(
    !withSupport.assignments.some((a) => a.caddy.id === 90),
    "예약이 충분하면 지원자는 대기만"
  );
}

section("1막 / 1·2 / 1·3 / 54홀 우선순위 유지");
{
  const date = "2026-08-26";
  const available = [house(1, 1), house(2, 2), house(3, 3), house(4, 4)];
  const oneMak = { id: 61, name: "막A", team: "2조", teamOrder: 8, inputOrder: 1 };
  const off = supportCaddy(90, "휴무지원");
  const result = computeAutoAssignmentsV1({
    date,
    available,
    oneMakCandidates: [oneMak],
    reservations: shiftRes(date, "1부", 6),
    specialSupportByShift: { ...emptySpecialSupportByShift(), "1부": [off] },
  });
  const firstMak = result.assignments.find((a) => a.kind === "oneMak");
  const supportRow = result.assignments.find((a) => a.kind === "specialSupport");
  assert(firstMak?.caddy.id === 61, "1막이 먼저 배치");
  assert(supportRow?.caddy.id === 90, "지원은 남은 자리");
  const makTee = firstMak?.reservation.teeTime || "";
  const supportTee = supportRow?.reservation.teeTime || "";
  assert(makTee <= supportTee, "1막 티타임이 지원보다 앞이거나 같음");
}

section("WEEKEND 평일 규칙 유지");
{
  const date = "2026-08-26";
  const weekend: AutoAssignCaddy = {
    id: 77,
    name: "주말반",
    team: "9조",
    teamOrder: 9,
    caddyType: "THIRD",
    thirdBandSubgroup: "WEEKEND",
    employmentStatus: "ACTIVE",
  };
  const result = computeAutoAssignmentsV1({
    date,
    available: [house(1, 1), house(2, 2), weekend],
    reservations: [
      ...shiftRes(date, "1부", 2),
      ...shiftRes(date, "2부", 2),
      ...shiftRes(date, "3부", 2),
    ],
    specialSupportByShift: {
      ...emptySpecialSupportByShift(),
      "3부": [supportCaddy(90, "휴무3부")],
    },
  });
  assert(
    !result.assignments.some((a) => a.shift === "3부" && a.caddy.id === 77),
    "평일 3부에 WEEKEND 없음"
  );
}

section("Mode A/B 뒤에만 지원");
{
  const date = "2026-08-26";
  const available = [
    house(1, 1),
    house(2, 2),
    house(3, 3),
    house(4, 4),
    third(11, 1),
  ];
  const marshal = supportCaddy(91, "마샬3");
  const reservations = [
    ...shiftRes(date, "1부", 2),
    ...shiftRes(date, "2부", 2),
    ...shiftRes(date, "3부", 8),
  ];
  const result = computeAutoAssignmentsV1({
    date,
    available,
    reservations,
    specialSupportByShift: { ...emptySpecialSupportByShift(), "3부": [marshal] },
  });
  const s3 = result.assignments.filter((a) => a.shift === "3부");
  const supportIdx = s3.findIndex((a) => a.kind === "specialSupport");
  const lastNormal = s3.reduce(
    (idx, a, i) => (a.kind !== "specialSupport" ? i : idx),
    -1
  );
  assert(supportIdx === -1 || supportIdx > lastNormal, "3부 지원은 Mode A/B 뒤");
}

section("reflow 시 지정 부에만 남음");
{
  const date = "2026-08-26";
  const available = [house(1, 1), house(2, 2), house(3, 3)];
  const off = supportCaddy(90, "휴무지원");
  const reservations = [
    ...shiftRes(date, "1부", 4),
    ...shiftRes(date, "2부", 2),
  ];
  const previous = computeAutoAssignmentsV1({
    date,
    available,
    reservations,
    specialSupportByShift: { ...emptySpecialSupportByShift(), "1부": [off] },
  });
  const cancel = previous.assignments.find(
    (a) => a.shift === "1부" && a.kind === "regular"
  );
  assert(!!cancel, "취소 대상 있음");
  const after = reflowRegularAssignments({
    previous,
    regularCaddyPool: available,
    events: [
      {
        type: "CANCEL_RESERVATION",
        reservationKey: reservationKey(cancel!.reservation),
      },
    ],
    specialSupportByShift: { ...emptySpecialSupportByShift(), "1부": [off] },
  });
  assert(
    after.after.assignments.every(
      (a) => a.caddy.id !== 90 || a.shift === "1부"
    ),
    "지원자가 2부로 누수되지 않음"
  );
  assert(
    after.after.assignments.filter((a) => a.caddy.id === 90).every(
      (a) => a.kind === "specialSupport"
    ),
    "지원 배정은 specialSupport 유지"
  );
}

section("Draft round-trip / Published snapshot");
{
  const date = "2026-08-26";
  const available = [house(1, 1), house(2, 2)];
  const off = supportCaddy(90, "휴무지원");
  const result = computeAutoAssignmentsV1({
    date,
    available,
    reservations: shiftRes(date, "1부", 3),
    specialSupportByShift: { ...emptySpecialSupportByShift(), "1부": [off] },
  });
  const draft = draftFromResult(result, available);
  assert(
    !draft.caddyPool.some((c) => c.id === 90),
    "caddyPool에 지원자 넣지 않음"
  );
  const payload = assignmentDraftToPayload(draft);
  const published = buildPublishedPayloadFromDraft(payload);
  const supportPlacement = published.placements.find((p) => p.caddyId === 90);
  assert(supportPlacement?.specialSupport === true, "Published에 지원 보존");
  assert(supportPlacement?.kind === "specialSupport", "Published kind 보존");
  assert(supportPlacement?.chageun === false, "찾근으로 취급하지 않음");
  assert(supportPlacement?.locked === false, "LOCK 아님");
  const marks = boardAssignmentMarks(
    result.assignments.find((a) => a.caddy.id === 90)!,
    result.assignments
  );
  assert(marks.specialSupport === true && marks.chageun === false, "관리 보드 지원 표시");
}

section("source / UI / migration / 권한");
{
  const sql = readSrc(
    "prisma/migrations/20260827120000_daily_special_support/migration.sql"
  );
  const schema = readSrc("prisma/schema.prisma");
  const panel = readSrc("src/app/manage/assignments/SpecialDutyPanel.tsx");
  const supportUi = readSrc(
    "src/app/manage/assignments/SpecialSupportPanel.tsx"
  );
  const page = readSrc("src/app/manage/assignments/page.tsx");
  const route = readSrc("src/app/api/daily-special-supports/route.ts");
  const engine = readSrc("src/lib/autoAssignEngine.ts");
  const preview = readSrc("src/app/api/assignments/preview/route.ts");
  const reflow = readSrc("src/app/api/assignments/reflow/route.ts");
  const apply = readSrc("src/app/api/assignments/reflow/apply/route.ts");
  const publishedView = readSrc("src/components/board/PublishedBoardView.tsx");

  assert(/CREATE TABLE "DailySpecialSupport"/.test(sql), "additive CREATE TABLE");
  assert(
    /UNIQUE INDEX "DailySpecialSupport_date_caddyId_shift_key"/.test(sql),
    "(date,caddyId,shift) unique"
  );
  assert(!/DROP TABLE/.test(sql), "no DROP");
  assert(!/ALTER TABLE "DailySpecialDuty"/.test(sql), "DailySpecialDuty 미변경");
  assert(!/DROP TYPE "DailySpecialKind"/.test(sql), "CHAGEUN enum 유지");
  assert(/model DailySpecialSupport/.test(schema), "schema model");
  assert(/createdByUserId\s+Int\?/.test(schema), "nullable createdByUserId");
  assert(/DAILY_SPECIAL_KIND_UI\.map/.test(panel), "찾근 탭 제거");
  assert(/특수지원 등록/.test(supportUi), "특수지원 등록 액션");
  assert(/const \[busy, setBusy\]/.test(supportUi), "저장 busy state");
  assert(/1부 지원/.test(supportUi), "부별 인원 요약");
  assert(/ss-kinds/.test(supportUi), "mobile 3부 탭");
  assert(/SpecialSupportPanel/.test(page), "날짜 설정에 특수지원");
  assert(/requireAdmin/.test(route), "API requireAdmin");
  assert(/kind: "specialSupport"/.test(engine), "assignment kind");
  assert(/pickNextSpecialSupport/.test(engine), "보충 큐 사용");
  assert(/houseAssigned \+= 1/.test(engine), "정상 houseAssigned 유지");
  assert(
    /specialSupportByShift: await loadSpecialSupportQueuesForDate/.test(preview),
    "preview는 서버에서 특수지원을 다시 읽음"
  );
  assert(
    /loadSpecialSupportQueuesForDate/.test(reflow) &&
      /loadSpecialSupportQueuesForDate/.test(apply),
    "reflow/apply도 서버에서 다시 읽음"
  );
  assert(/bc-badge support/.test(publishedView), "Published 지원 뱃지");
  const supportDomain = readSrc("src/lib/dailySpecialSupport.ts");
  assert(
    !/DailySpecialKind/.test(supportDomain) &&
      !/kind:\s*"CHAGEUN"/.test(engine) &&
      /kind: "specialSupport"/.test(engine),
    "특수지원이 CHAGEUN을 재사용하지 않음"
  );
}

console.log(`\nOK ${passed}/${passed + failed}`);
if (failed > 0) process.exit(1);
