/**
 * P4 벌당 발생관리 UI 계약 (production write 없음)
 * 실행: npm run test:marshal-penalty-occurrence-ui-unit
 */
import fs from "node:fs";
import path from "node:path";
import {
  DUTY_PANEL_TITLE,
  OCCURRENCE_PANEL_TITLE,
  canCancelOccurrence,
  canChangeOccurrenceDate,
  classifyOccurrenceWait,
  makeOccurrenceIdempotencyKey,
  occurrenceCalendarBadgeText,
  occurrenceConflictMessage,
  occurrenceRegisterBlocked,
  occurrenceSourceLabel,
  occurrenceStatusLabel,
  occurrenceWaitLabel,
  previewChangedNormalNames,
  previewExistingPenaltyNames,
  previewOtherDatesUnchanged,
  previewOverrideNames,
  regenerationBannerText,
  scheduledOccurrencesOnDate,
  targetMonthFromOccurredOnYmd,
} from "../src/lib/marshalPenaltyOccurrenceUi";

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

function read(rel: string) {
  return fs.readFileSync(path.resolve(rel), "utf8");
}

section("labels");
{
  assert(OCCURRENCE_PANEL_TITLE.includes("다음 달 전일"), "신규 명칭");
  assert(DUTY_PANEL_TITLE.includes("조출/후출"), "기존 명칭");
  assert(occurrenceStatusLabel("OPEN") === "대기", "OPEN 한글");
  assert(occurrenceStatusLabel("SCHEDULED") === "배정됨", "SCHEDULED 한글");
  assert(occurrenceStatusLabel("CANCELLED") === "취소", "CANCELLED 한글");
  assert(occurrenceSourceLabel("AUTO") === "자동", "AUTO 한글");
  assert(occurrenceSourceLabel("MANUAL") === "수동지정", "MANUAL 한글");
  assert(
    occurrenceCalendarBadgeText({ name: "김", source: "MANUAL" }) ===
      "김 전일·수동지정",
    "달력 전일 배지"
  );
}

section("OPEN wait kinds");
{
  assert(
    classifyOccurrenceWait({ status: "OPEN", planGenerated: false }).kind ===
      "not_generated",
    "월표 미생성"
  );
  assert(
    occurrenceWaitLabel({
      status: "OPEN",
      deferReason: "하루 벌당 정원을 초과합니다.",
    }) === "정원 부족",
    "정원 부족"
  );
  assert(
    occurrenceWaitLabel({
      status: "OPEN",
      deferReason: "병가 날짜는 건너뜁니다.",
    }) === "병가",
    "병가 leftover"
  );
  assert(
    occurrenceWaitLabel({
      status: "OPEN",
      deferReason: "이미 수동 벌당이 있는 날입니다.",
    }) === "날짜 충돌",
    "수동 날짜 충돌"
  );
  assert(
    occurrenceWaitLabel({
      status: "OPEN",
      deferReason: "월표 생성 이후 등록되어 재생성이 필요합니다.",
    }) === "재생성 필요",
    "재생성 필요"
  );
  assert(occurrenceWaitLabel({ status: "SCHEDULED" }) === "", "배정됨은 대기 아님");
  assert(
    classifyOccurrenceWait({
      status: "OPEN",
      planGenerated: true,
    }).label === "미배정",
    "월표 있는데 사유 없으면 미배정"
  );
}

section("guards and keys");
{
  assert(
    targetMonthFromOccurredOnYmd("2095-10-18")?.month === 11,
    "발생일 다음 달이 대상 월"
  );
  const key = makeOccurrenceIdempotencyKey({
    caddyId: 12,
    occurredOn: "2095-10-01",
    nonce: "abc",
  });
  assert(key === "ui-12-2095-10-01-abc", "idempotencyKey 형식");
  assert(
    occurrenceRegisterBlocked({
      locked: false,
      caddyId: "1",
      occurredOn: "2095-10-01",
      reason: "",
    }),
    "사유 없으면 등록 차단"
  );
  assert(
    !canChangeOccurrenceDate({ status: "CANCELLED", planStatus: "DRAFT" }),
    "취소 건 날짜 변경 금지"
  );
  assert(
    !canChangeOccurrenceDate({ status: "SCHEDULED", planStatus: "FINALIZED" }),
    "FINALIZED 날짜 변경 금지"
  );
  assert(
    !canCancelOccurrence({ status: "SCHEDULED", planStatus: "FINALIZED" }),
    "FINALIZED 취소 금지"
  );
  assert(
    canCancelOccurrence({ status: "OPEN", planStatus: "DRAFT" }),
    "OPEN 취소 가능"
  );
}

section("preview / conflict copy");
{
  assert(
    occurrenceConflictMessage({ code: "stale_preview" }).includes("다시 미리보기"),
    "stale preview 안내"
  );
  assert(
    occurrenceConflictMessage({ code: "sick_date" }).includes("병가"),
    "병가 409"
  );
  assert(
    previewOtherDatesUnchanged({
      fromDate: "2095-11-02",
      toDate: "2095-11-06",
      otherOccurrences: [{ id: 1, unchanged: true }],
    }),
    "다른 벌당 날짜 유지"
  );
  const previewPeople = {
    fromDate: "2095-11-02",
    toDate: "2095-11-06",
    toDay: {
      before: [
        { caddyId: 1, name: "기존벌당", source: "PENALTY" },
        { caddyId: 2, name: "대타", source: "SUBSTITUTE" },
        { caddyId: 3, name: "수동", source: "MANUAL" },
        { caddyId: 4, name: "순환", source: "ROTATION" },
      ],
      after: [],
    },
    rotationImpact: {
      displaced: [{ caddyId: 4, shift: "AM" }],
    },
  };
  assert(
    previewExistingPenaltyNames(previewPeople).join() === "기존벌당",
    "미리보기 기존 벌당자"
  );
  assert(
    previewOverrideNames(previewPeople).join("·") === "대타·수동",
    "미리보기 대타/수동"
  );
  assert(
    previewChangedNormalNames(previewPeople, new Map([[4, "순환"]])).join() ===
      "순환",
    "미리보기 변경 정상 마샬"
  );
  assert(
    occurrenceConflictMessage({ code: "same_day_duplicate" }).includes("이미 배정"),
    "같은 날 중복 안내"
  );
  assert(
    occurrenceConflictMessage({ code: "preview_token_required" }).includes(
      "미리보기"
    ),
    "Apply 전 Preview 안내"
  );
  assert(
    regenerationBannerText({ needsRegeneration: true, planStatus: "DRAFT" })
      ?.includes("다시 생성해야") === true,
    "재생성 배너"
  );
  assert(
    regenerationBannerText({ needsRegeneration: true, planStatus: "FINALIZED" }) ==
      null,
    "FINALIZED는 재생성 배너 없음"
  );
  const onDay = scheduledOccurrencesOnDate(
    [
      {
        id: 1,
        caddyId: 10,
        occurredOn: "2095-10-01",
        targetYear: 2095,
        targetMonth: 11,
        scheduledOn: "2095-11-01",
        scheduleSource: "AUTO",
        status: "SCHEDULED",
        deferReason: null,
        reason: "r",
      },
      {
        id: 2,
        caddyId: 20,
        occurredOn: "2095-10-02",
        targetYear: 2095,
        targetMonth: 11,
        scheduledOn: null,
        scheduleSource: "AUTO",
        status: "OPEN",
        deferReason: null,
        reason: "r",
      },
    ],
    "2095-11-01"
  );
  assert(onDay.length === 1 && onDay[0].caddyId === 10, "배정일만 달력에");
}

section("source contracts");
{
  const page = read("src/app/manage/marshals/schedule/page.tsx");
  const panel = read("src/components/manage/MarshalPenaltyOccurrencePanel.tsx");
  const css = read("src/app/globals.css");
  const ui = read("src/lib/marshalPenaltyOccurrenceUi.ts");
  assert(page.includes("MarshalPenaltyOccurrencePanel"), "page 발생 패널");
  assert(page.includes("DUTY_PANEL_TITLE"), "page 기존 벌당 명칭");
  assert(panel.includes("OCCURRENCE_PANEL_TITLE"), "패널 제목 상수");
  assert(page.includes("needsRegeneration"), "재생성 잠금");
  assert(page.includes("data-marshal-regen-banner"), "재생성 배너");
  assert(panel.includes("/api/marshals/penalty-occurrences"), "등록 API");
  assert(panel.includes("idempotencyKey"), "중복 등록 방지");
  assert(panel.includes("schedule/preview"), "Preview API");
  assert(panel.includes("schedule/apply"), "Apply API");
  assert(panel.includes("previewToken"), "Preview 없이 Apply 금지");
  assert(panel.includes("/cancel"), "취소 API");
  assert(panel.includes("window.confirm"), "취소 확인");
  assert(panel.includes("data-marshal-occurrence-cancel"), "취소 버튼 마커");
  assert(panel.includes("stale_preview"), "stale 재미리보기");
  assert(panel.includes("confirmOff"), "휴무 승인");
  assert(panel.includes("기존 벌당자"), "미리보기 기존 벌당");
  assert(panel.includes("대타/수동배치"), "미리보기 대타 충돌");
  assert(panel.includes("휴무 충돌을 확인하고"), "휴무 명시 승인");
  assert(
    page.indexOf("MarshalPenaltyOccurrencePanel") <
      page.indexOf('data-marshal-schedule="board"'),
    "월표 없어도 발생 목록이 달력보다 앞"
  );
  assert(css.includes(".ms-occ-list"), "압축 목록 css");
  assert(css.includes(".ms-occ-main"), "행 터치 영역");
  assert(
    /@media \(min-width: 720px\)[\s\S]*\.ms-occ-head/m.test(css),
    "PC 표 헤더"
  );
  assert(!ui.includes("autoAssignEngine"), "UI helper 엔진 없음");
  assert(!panel.includes("generateMonthRotation"), "패널 순환 엔진 없음");
  assert(!page.includes("coverage: penalty"), "기존 벌당 coverage 생략 유지");
}

if (failed > 0) {
  console.error(`\nFAIL ${failed} (passed ${passed})`);
  process.exit(1);
}
console.log(`\nOK ${passed}`);
