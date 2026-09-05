/**
 * 배치 상호작용 A~D 단위 테스트 (DB write 없음)
 * 실행: npx tsx scripts/test-board-mutation-interaction-unit.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildLiveChangePersistPlan,
  makeMoveReservationChange,
  previewLiveAssignmentChange,
} from "../src/lib/assignmentChange";
import {
  confirmedDraftKeepingPlacedUnavailable,
  createDraftFromAutoResult,
} from "../src/lib/assignmentDraft";
import {
  computeAutoAssignmentsV1,
  compareCaddyOrder,
  reflowRegularAssignments,
  reservationKey,
  type AutoAssignCaddy,
  type AutoAssignReservation,
  type AutoAssignResultV1,
} from "../src/lib/autoAssignEngine";
import {
  overlayUnavailableIdsKeepingPlaced,
  overlayUnavailableKeepingShift,
} from "../src/lib/caddyPoolCanonical";
import {
  emptySpecialSupportByShift,
  isSpecialSupportDraftStale,
  isSpecialSupportStalePipelineBlock,
} from "../src/lib/dailySpecialSupport";
import { publishBoardActionState } from "../src/lib/publishDailyBoardClient";

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
    team: `${((order - 1) % 8) + 1}조`,
    teamOrder: 1,
    caddyType: "HOUSE",
    employmentStatus: "ACTIVE",
  };
}

function supportCaddy(id: number, name: string): AutoAssignCaddy {
  return {
    id,
    name,
    team: "7조",
    teamOrder: 1,
    caddyType: "HOUSE",
    employmentStatus: "ACTIVE",
  };
}

function makeCaddies(n: number, startId = 1): AutoAssignCaddy[] {
  const out: AutoAssignCaddy[] = [];
  for (let i = 0; i < n; i++) {
    out.push(house(startId + i, i + 1));
  }
  return out.sort(compareCaddyOrder);
}

function res(
  date: string,
  id: string,
  opts: { teeTime: string; shift?: string; course?: string }
): AutoAssignReservation {
  return {
    id,
    date,
    course: opts.course || "SKY",
    shift: opts.shift || "1부",
    teeTime: opts.teeTime,
    teamName: id,
    rawRowIndex: Number(id.replace(/\D/g, "") || 1),
  };
}

function caddyOn(result: AutoAssignResultV1, reservationId: string): number | undefined {
  return result.assignments.find((a) => a.reservation.id === reservationId)?.caddy.id;
}

function laterShiftIds(result: AutoAssignResultV1, caddyId: number): string[] {
  return result.assignments
    .filter((a) => a.caddy.id === caddyId && a.shift !== "1부")
    .map((a) => `${a.shift}:${a.kind}`);
}

section("1. 2부 effective 병가: 1부 유지 + 2·3부 재등장 금지");
{
  const date = "2026-08-27";
  const pool = makeCaddies(10);
  const previous = computeAutoAssignmentsV1({
    date,
    available: pool,
    reservations: [
      res(date, "A1", { teeTime: "07:00", shift: "1부" }),
      res(date, "A2", { teeTime: "07:08", shift: "1부" }),
      res(date, "A3", { teeTime: "07:16", shift: "1부" }),
      res(date, "B1", { teeTime: "12:00", shift: "2부" }),
      res(date, "B2", { teeTime: "12:08", shift: "2부" }),
      res(date, "B3", { teeTime: "12:16", shift: "2부" }),
      res(date, "C1", { teeTime: "16:00", shift: "3부" }),
      res(date, "C2", { teeTime: "16:08", shift: "3부" }),
    ],
  });
  const b1Id = caddyOn(previous, "B1")!;
  const shift1Before = previous.assignments
    .filter((a) => a.shift === "1부")
    .map((a) => `${a.reservation.id}:${a.caddy.id}`)
    .sort()
    .join("|");
  const preview = previewLiveAssignmentChange({
    previous,
    regularCaddyPool: pool,
    change: { type: "CADDY_SICK", caddyId: b1Id, shift: "2부" },
  });
  const shift1After = preview.after.assignments
    .filter((a) => a.shift === "1부")
    .map((a) => `${a.reservation.id}:${a.caddy.id}`)
    .sort()
    .join("|");
  assert(shift1After === shift1Before, "2부 병가 후 1부 identity 유지");
  assert(laterShiftIds(preview.after, b1Id).length === 0, "2·3부에 병가 캐디 없음");
  const from = preview.after.unavailableFromShift?.find((row) => row.caddyId === b1Id);
  assert(from?.effectiveFromShift === "2부", "after.unavailableFromShift=2부");
}

section("2. 부분 병가 후 MOVE: later shift regular 재선택 금지");
{
  const date = "2026-08-27";
  const pool = makeCaddies(10);
  const previous = computeAutoAssignmentsV1({
    date,
    available: pool,
    reservations: [
      res(date, "A1", { teeTime: "07:00", shift: "1부" }),
      res(date, "A2", { teeTime: "07:08", shift: "1부" }),
      res(date, "B1", { teeTime: "12:00", shift: "2부", course: "SKY" }),
      res(date, "B2", { teeTime: "12:08", shift: "2부", course: "SKY" }),
      res(date, "C1", { teeTime: "16:00", shift: "3부" }),
    ],
  });
  const b1Id = caddyOn(previous, "B1")!;
  const sick = previewLiveAssignmentChange({
    previous,
    regularCaddyPool: pool,
    change: { type: "CADDY_SICK", caddyId: b1Id, shift: "2부" },
  });
  const overlay = overlayUnavailableKeepingShift({
    dailyUnavailable: sick.after.unavailableFromShift,
    placedIds: sick.after.assignments.map((row) => row.caddy.id),
  });
  assert(
    overlay.some((row) => row.caddyId === b1Id && row.effectiveFromShift === "2부"),
    "still-placed 2부 병가는 overlay에서 유지"
  );
  const allDayOverlay = overlayUnavailableIdsKeepingPlaced({
    dailyUnavailableIds: [b1Id],
    placedIds: sick.after.assignments.map((row) => row.caddy.id),
  });
  const stillOn1 = sick.after.assignments.some(
    (row) => row.shift === "1부" && row.caddy.id === b1Id
  );
  if (stillOn1) {
    assert(!allDayOverlay.includes(b1Id), "ID-only overlay는 1부 잔존 시 종일로 빼지 않음");
  }
  const b2 = sick.after.assignments.find(
    (row) => row.shift === "2부" && row.reservation.id === "B2"
  );
  assert(!!b2, "MOVE 소스 2부 예약 있음");
  const moved = reflowRegularAssignments({
    previous: {
      ...sick.after,
      unavailableCaddyIds: overlay.map((row) => row.caddyId),
      unavailableFromShift: overlay,
    },
    regularCaddyPool: pool,
    events: [
      {
        type: "MOVE_RESERVATION",
        reservationKey: reservationKey(b2!.reservation),
        to: { course: "VERTHILL", shift: "2부", teeTime: "12:08" },
      },
    ],
  });
  assert(moved.warnings.every((w) => w.level !== "error"), "부분 병가 후 MOVE 성공");
  assert(laterShiftIds(moved.after, b1Id).length === 0, "MOVE 후에도 2·3부 재선택 없음");
}

section("3. 1부 specialSupport는 later reflow에서 regular HOUSE로 재선택되지 않음");
{
  const date = "2026-08-26";
  const available = [house(1, 1), house(2, 2), house(3, 3)];
  const off = supportCaddy(90, "휴무지원");
  const previous = computeAutoAssignmentsV1({
    date,
    available,
    reservations: [
      res(date, "A1", { teeTime: "07:00", shift: "1부", course: "SKY" }),
      res(date, "A2", { teeTime: "07:08", shift: "1부", course: "SKY" }),
      res(date, "A3", { teeTime: "07:16", shift: "1부", course: "OCEAN" }),
      res(date, "A4", { teeTime: "07:24", shift: "1부", course: "LAKE" }),
      res(date, "B1", { teeTime: "12:00", shift: "2부", course: "SKY" }),
      res(date, "B2", { teeTime: "12:08", shift: "2부", course: "SKY" }),
    ],
    specialSupportByShift: { ...emptySpecialSupportByShift(), "1부": [off] },
  });
  assert(
    previous.assignments.some(
      (row) => row.kind === "specialSupport" && row.caddy.id === 90 && row.shift === "1부"
    ),
    "1부에 specialSupport 배정"
  );
  const b1 = previous.assignments.find((row) => row.reservation.id === "B1");
  const leakyPool = [...available, off];
  const moved = reflowRegularAssignments({
    previous,
    regularCaddyPool: leakyPool,
    events: [
      {
        type: "MOVE_RESERVATION",
        reservationKey: reservationKey(b1!.reservation),
        to: { course: "VERTHILL", shift: "2부", teeTime: "12:00" },
      },
    ],
    specialSupportByShift: { ...emptySpecialSupportByShift(), "1부": [off] },
  });
  assert(
    moved.after.assignments
      .filter((row) => row.caddy.id === 90)
      .every((row) => row.kind === "specialSupport" && row.shift === "1부"),
    "지원자는 1부 specialSupport만 유지"
  );
  assert(
    !moved.after.assignments.some(
      (row) => row.caddy.id === 90 && row.kind === "regular"
    ),
    "later reflow에서 regular HOUSE로 재선택되지 않음"
  );
}

section("4~6. 지원 설정 vs Draft stale / 차단 / 재맞추기 후 해제");
{
  const queues = { ...emptySpecialSupportByShift(), "1부": [supportCaddy(90, "휴무지원")] };
  const ghostDraft = [
    {
      kind: "specialSupport",
      shift: "1부",
      caddy: { id: 90 },
    },
  ];
  const emptyDraft: typeof ghostDraft = [];
  const matchingDraft = ghostDraft;
  assert(
    isSpecialSupportDraftStale(emptySpecialSupportByShift(), ghostDraft),
    "지원 삭제 후 Draft 잔존이면 stale"
  );
  assert(
    isSpecialSupportDraftStale(queues, emptyDraft),
    "지원 추가 후 Draft 미반영이면 stale"
  );
  assert(
    !isSpecialSupportDraftStale(queues, matchingDraft),
    "재맞추기 후 설정=Draft 이면 stale 해제"
  );
  assert(isSpecialSupportStalePipelineBlock("CADDY_SICK"), "stale 중 SICK 차단");
  assert(isSpecialSupportStalePipelineBlock("MOVE_RESERVATION"), "stale 중 MOVE 차단");
  assert(!isSpecialSupportStalePipelineBlock("SWAP_CADDY"), "stale이어도 SWAP은 이 가드 밖");
  const blockedPublish = publishBoardActionState({
    publishing: false,
    hasDraft: true,
    published: null,
    draftVersion: 1,
    blocked: true,
  });
  assert(blockedPublish.disabled, "stale 중 publish 버튼 비활성");
}

section("7. engine effectiveFromShift == persisted effectiveFromShift");
{
  const date = "2026-08-27";
  const pool = makeCaddies(4);
  const previous = computeAutoAssignmentsV1({
    date,
    available: pool,
    reservations: [
      res(date, "A1", { teeTime: "07:00", shift: "1부" }),
      res(date, "A2", { teeTime: "07:08", shift: "1부" }),
      res(date, "A3", { teeTime: "07:16", shift: "1부" }),
      res(date, "B1", { teeTime: "12:00", shift: "2부" }),
      res(date, "B2", { teeTime: "12:08", shift: "2부" }),
      res(date, "B3", { teeTime: "12:16", shift: "2부" }),
    ],
  });
  const dual = previous.assignments
    .filter((row) => row.kind === "regular" && row.caddy.caddyType === "HOUSE")
    .reduce<number | null>((found, row) => {
      if (found) return found;
      const other = previous.assignments.some(
        (alt) =>
          alt.caddy.id === row.caddy.id &&
          alt.shift !== row.shift &&
          (alt.shift === "1부" || alt.shift === "2부") &&
          alt.kind === "regular"
      );
      return other ? row.caddy.id : null;
    }, null);
  assert(!!dual, "1·2 regular HOUSE 쌍소비 캐디 존재");
  const preview = previewLiveAssignmentChange({
    previous,
    regularCaddyPool: pool,
    change: { type: "CADDY_SICK", caddyId: dual!, shift: "2부" },
  });
  const engineFrom = preview.after.unavailableFromShift?.find(
    (row) => row.caddyId === dual
  )?.effectiveFromShift;
  const plan = buildLiveChangePersistPlan(preview);
  const persisted = plan.unavailables.find((row) => row.caddyId === dual);
  assert(engineFrom === "1부", "엔진은 쌍소비를 종일(1부)로 해석");
  assert(persisted?.effectiveFromShift === engineFrom, "persist effectiveFromShift=엔진 결과");
  assert(
    preview.after.assignments.every((row) => row.caddy.id !== dual),
    "종일 제외라 1·2·3부 모두 제거"
  );
}

section("8. 기존 정상: 종일 병가 / 빈칸 MOVE / specialSupport");
{
  const date = "2026-08-27";
  const pool = makeCaddies(8);
  const previous = computeAutoAssignmentsV1({
    date,
    available: pool,
    reservations: [
      res(date, "A1", { teeTime: "07:00", shift: "1부", course: "SKY" }),
      res(date, "A2", { teeTime: "07:08", shift: "1부", course: "SKY" }),
      res(date, "B1", { teeTime: "12:00", shift: "2부", course: "SKY" }),
    ],
  });
  const a1Id = caddyOn(previous, "A1")!;
  const allDay = previewLiveAssignmentChange({
    previous,
    regularCaddyPool: pool,
    change: { type: "CADDY_SICK", caddyId: a1Id, shift: "1부" },
  });
  assert(
    allDay.after.assignments.every((row) => row.caddy.id !== a1Id),
    "종일 병가는 모든 부에서 제외"
  );
  const moved = previewLiveAssignmentChange({
    previous: allDay.after,
    regularCaddyPool: pool,
    change: makeMoveReservationChange({
      reservationKey: reservationKey(
        allDay.after.assignments.find((row) => row.reservation.id === "B1")!
          .reservation
      ),
      to: { course: "VERTHILL", shift: "2부", teeTime: "12:00" },
    }),
  });
  assert(moved.warnings.every((w) => w.level !== "error"), "일반 빈칸 MOVE 유지");
  assert(
    moved.after.assignments.every((row) => row.caddy.id !== a1Id),
    "종일 병가 후 MOVE가 병가 캐디를 되살리지 않음"
  );
  const off = supportCaddy(90, "휴무지원");
  const supportBoard = computeAutoAssignmentsV1({
    date,
    available: [house(1, 1), house(2, 2)],
    reservations: [
      res(date, "S1", { teeTime: "07:00", shift: "1부" }),
      res(date, "S2", { teeTime: "07:08", shift: "1부" }),
      res(date, "S3", { teeTime: "07:16", shift: "1부" }),
    ],
    specialSupportByShift: { ...emptySpecialSupportByShift(), "1부": [off] },
  });
  assert(
    supportBoard.assignments.some(
      (row) => row.kind === "specialSupport" && row.caddy.id === 90
    ),
    "정상 specialSupport 배정 유지"
  );
  const draft = createDraftFromAutoResult(allDay.after, pool);
  const hydrated = confirmedDraftKeepingPlacedUnavailable(draft, [a1Id]);
  assert(
    (hydrated.unavailableCaddyIds || []).includes(a1Id) ||
      !hydrated.assignments.some((row) => row.caddy.id === a1Id),
    "종일 병가 hydrate overlay는 보드에 없으면 유지"
  );
}

section("source: hydrate stale restore + pipeline/publish block");
{
  const page = readFileSync(
    join(process.cwd(), "src/app/manage/assignments/page.tsx"),
    "utf8"
  );
  const apply = readFileSync(
    join(process.cwd(), "src/lib/quickBoardMutationApply.ts"),
    "utf8"
  );
  const engine = readFileSync(
    join(process.cwd(), "src/lib/autoAssignEngine.ts"),
    "utf8"
  );
  const change = readFileSync(
    join(process.cwd(), "src/lib/assignmentChange.ts"),
    "utf8"
  );
  assert(
    /isSpecialSupportDraftStale\(/.test(page) &&
      /specialSupportHydratedRef/.test(page),
    "hydrate 시 지원 설정 vs Draft 비교"
  );
  assert(
    /isSpecialSupportStalePipelineBlock\(change\.type\)/.test(page) &&
      /blocked: specialSettingsStale/.test(page) &&
      /if \(specialSettingsStale\)/.test(page),
    "stale 중 SICK/MOVE/publish 차단"
  );
  assert(
    /setSpecialSettingsStale\(false\)/.test(page) &&
      /RECALC_SUCCESS_MESSAGE/.test(page),
    "재맞추기 성공 후 stale 해제 경로 유지"
  );
  assert(
    /overlayUnavailableKeepingShift/.test(apply) &&
      /unavailableFromShift: overlayFromShift/.test(apply),
    "quick mutation previous에 부 범위 unavailable 유지"
  );
  assert(
    /specialSupportExcludeIds\(/.test(engine),
    "reflow regular pool에서 특수지원 제외"
  );
  assert(
    /fromById\.get\(event\.caddyId\)/.test(change),
    "persist effectiveFromShift는 엔진 after 기준"
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
