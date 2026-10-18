/**
 * 마샬 월표 화면 계약 (production write 없음)
 * 실행: npm run test:marshal-schedule-ui-unit
 */
import fs from "node:fs";
import path from "node:path";
import {
  buildMonthCalendar,
  formatCompactDayLine,
  formatCompactShifts,
  listMonthDayBoards,
  marshalScheduleIntroText,
  classifyScheduleFetchResult,
  matchesRequestedYearMonth,
  nextFetchStateAfterLoad,
  nextScheduleRequestId,
  planStatusLabel,
  resolveMarshalScheduleFetchState,
  scheduleEmptyAllowed,
  scheduleFetchErrorMessage,
  scheduleFetchFailureKind,
  scheduleMutationBlocked,
  schedulePlanDisplayAllowed,
  scheduleWorkspaceVisible,
  shiftYearMonth,
  shouldApplyScheduleFetch,
  shouldScrollPcDayDetail,
  summarizeMarshalNames,
  weekdayIndexFromYmd,
  type MarshalScheduleSlotView,
} from "../src/lib/marshalScheduleUi";

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

function read(rel: string) {
  return fs.readFileSync(path.resolve(rel), "utf8");
}

function slot(
  partial: Partial<MarshalScheduleSlotView> & {
    id: number;
    date: string;
    shift: "AM" | "PM";
    name: string;
  }
): MarshalScheduleSlotView {
  return {
    id: partial.id,
    date: partial.date,
    shift: partial.shift,
    slotIndex: partial.slotIndex ?? 0,
    caddyId: partial.caddyId ?? partial.id,
    source: partial.source ?? "ROTATION",
    warning: partial.warning ?? null,
    note: partial.note ?? null,
    caddy: { id: partial.caddyId ?? partial.id, name: partial.name },
    originalCaddy: partial.originalCaddy ?? null,
  };
}

section("calendar months");
{
  const feb = buildMonthCalendar(2026, 2);
  assert(feb.filter((c) => c.inMonth).length === 28, "2026-02 28일");
  assert(feb.length % 7 === 0, "2026-02 7열");
  const leap = buildMonthCalendar(2024, 2);
  assert(leap.filter((c) => c.inMonth).length === 29, "2024-02 29일");
  const apr = buildMonthCalendar(2026, 4);
  assert(apr.filter((c) => c.inMonth).length === 30, "2026-04 30일");
  const oct = buildMonthCalendar(2026, 10);
  assert(oct.filter((c) => c.inMonth).length === 31, "2026-10 31일");
  assert(weekdayIndexFromYmd("2026-10-16") === 5, "2026-10-16 금요일");
  assert(oct.find((c) => c.ymd === "2026-10-16")?.weekday === 5, "달력 16일 금");
  assert(oct[0]?.weekday === 0, "달력 일요일 시작");
}

section("month nav");
{
  assert(shiftYearMonth(2026, 1, -1).year === 2025, "1월 이전 연도");
  assert(shiftYearMonth(2026, 1, -1).month === 12, "1월 이전 12월");
  assert(shiftYearMonth(2026, 12, 1).year === 2027, "12월 다음 연도");
  assert(shiftYearMonth(2026, 12, 1).month === 1, "12월 다음 1월");
}

section("AM2/PM1 and extra slots");
{
  const slots = [
    slot({ id: 1, date: "2026-10-16", shift: "AM", slotIndex: 0, name: "임형규" }),
    slot({ id: 2, date: "2026-10-16", shift: "AM", slotIndex: 1, name: "신정훈" }),
    slot({ id: 3, date: "2026-10-16", shift: "PM", slotIndex: 0, name: "한상준" }),
  ];
  const days = listMonthDayBoards({ year: 2026, month: 10, slots });
  const day = days.find((row) => row.ymd === "2026-10-16")!;
  assert(day.amNames.join(",") === "임형규,신정훈", "조출 2명");
  assert(day.pmNames.join(",") === "한상준", "후출 1명");
  assert(
    formatCompactDayLine(day) === "16 금 | 조출 임형규·신정훈 | 후출 한상준",
    "압축 한줄 AM2/PM1"
  );
  const pm2 = [
    ...slots,
    slot({ id: 4, date: "2026-10-16", shift: "PM", slotIndex: 1, name: "구본의" }),
    slot({ id: 5, date: "2026-10-16", shift: "AM", slotIndex: 2, name: "이상현" }),
  ];
  const extra = listMonthDayBoards({ year: 2026, month: 10, slots: pm2 }).find(
    (row) => row.ymd === "2026-10-16"
  )!;
  assert(extra.amNames.length === 3, "조출 추가 슬롯");
  assert(extra.pmNames.join(",") === "한상준,구본의", "후출 2명");
  assert(formatCompactShifts(extra).includes("구본의"), "후출2 압축 표시");
  assert(formatCompactShifts(extra).includes("이상현"), "조출 추가 압축 표시");
  assert(summarizeMarshalNames(extra.amNames, 2).text.includes("+1"), "달력 +N");
}

section("warnings substitute empty");
{
  const slots = [
    slot({
      id: 1,
      date: "2026-10-01",
      shift: "AM",
      name: "경고자",
      warning: "휴무 충돌",
      source: "SUBSTITUTE",
      originalCaddy: { id: 9, name: "원래이름" },
    }),
  ];
  const day = listMonthDayBoards({
    year: 2026,
    month: 10,
    slots,
    penalties: [{ date: "2026-10-01" }],
  }).find((row) => row.ymd === "2026-10-01")!;
  assert(day.hasWarning && day.hasSubstitute && day.hasPenalty, "경고/대타/벌당 플래그");
  const empty = listMonthDayBoards({ year: 2026, month: 11 })[0];
  assert(empty.amNames.length === 0 && empty.pmNames.length === 0, "월표 없음 빈 칸");
  assert(empty.occurrenceBadges.length === 0, "발생 배지 기본 없음");
  const occDay = listMonthDayBoards({
    year: 2026,
    month: 10,
    occurrences: [
      {
        caddyId: 7,
        scheduledOn: "2026-10-01",
        status: "SCHEDULED",
        scheduleSource: "MANUAL",
        caddy: { name: "전일자" },
      },
    ],
  }).find((row) => row.ymd === "2026-10-01")!;
  assert(
    occDay.occurrenceBadges[0]?.name === "전일자" &&
      occDay.occurrenceBadges[0]?.source === "MANUAL" &&
      occDay.hasPenalty,
    "전일 벌당 달력 배지"
  );
  assert(planStatusLabel(null) === "없음", "상태 없음");
  assert(planStatusLabel("DRAFT") === "초안 (DRAFT)", "상태 DRAFT");
  assert(planStatusLabel("FINALIZED") === "마감 (FINALIZED)", "상태 FINALIZED");
}

section("copy");
{
  const intro = marshalScheduleIntroText();
  assert(intro.includes("FINALIZED"), "FINALIZED 안내");
  assert(intro.includes("Daily Ops"), "Daily Ops 읽기 안내");
  assert(intro.includes("복사"), "복사 아님 안내");
  assert(!intro.includes("당일 투영은 다음 단계"), "오래된 투영 문구 제거");
}

section("month fetch safety");
{
  assert(nextScheduleRequestId(3) === 4, "request id 증가");
  assert(
    matchesRequestedYearMonth({ year: 2099, month: 10 }, 2099, 10),
    "year/month 일치"
  );
  assert(
    !matchesRequestedYearMonth({ year: 2099, month: 10 }, 2099, 11),
    "다른 월 불일치"
  );
  assert(
    !matchesRequestedYearMonth({ year: 2099, month: 10 }, 2098, 10),
    "다른 연 불일치"
  );
  assert(
    !matchesRequestedYearMonth(null, 2099, 10),
    "빈 payload 불일치"
  );
  assert(
    shouldApplyScheduleFetch({
      requestId: 2,
      latestRequestId: 2,
      payload: { year: 2099, month: 11 },
      year: 2099,
      month: 11,
    }),
    "최신 일치 응답 적용"
  );
  assert(
    !shouldApplyScheduleFetch({
      requestId: 1,
      latestRequestId: 2,
      payload: { year: 2099, month: 10 },
      year: 2099,
      month: 10,
    }),
    "이전 응답 순서 무시"
  );
  assert(
    !shouldApplyScheduleFetch({
      requestId: 2,
      latestRequestId: 2,
      payload: { year: 2099, month: 10 },
      year: 2099,
      month: 11,
    }),
    "다른 월 응답 무시"
  );
  assert(scheduleMutationBlocked({ loading: true, busy: false }), "조회 중 변경 차단");
  assert(scheduleMutationBlocked({ loading: false, busy: true }), "처리 중 변경 차단");
  assert(!scheduleMutationBlocked({ loading: false, busy: false }), "대기 시 변경 가능");
  assert(
    scheduleMutationBlocked({
      loading: false,
      busy: false,
      fetchState: "ERROR",
    }),
    "조회 실패 중 변경 차단"
  );
  assert(
    !scheduleMutationBlocked({
      loading: false,
      busy: false,
      fetchState: "SUCCESS_EMPTY",
    }),
    "정상 빈 월표는 설정 가능"
  );
  assert(
    shouldScrollPcDayDetail({ selectedDate: "2099-10-16", calendarDisplay: "block" }),
    "PC 달력 상세 스크롤"
  );
  assert(
    !shouldScrollPcDayDetail({ selectedDate: "2099-10-16", calendarDisplay: "none" }),
    "모바일 숨김 달력은 스크롤 없음"
  );
  assert(
    !shouldScrollPcDayDetail({ selectedDate: null, calendarDisplay: "block" }),
    "미선택 시 스크롤 없음"
  );
}

section("fetch state machine");
{
  assert(
    resolveMarshalScheduleFetchState({
      loading: true,
      fetchError: false,
      hasMatchingPayload: false,
      hasPlan: false,
    }) === "LOADING",
    "LOADING"
  );
  assert(
    resolveMarshalScheduleFetchState({
      loading: false,
      fetchError: false,
      hasMatchingPayload: true,
      hasPlan: false,
    }) === "SUCCESS_EMPTY",
    "정상 조회 월표 없음"
  );
  assert(
    resolveMarshalScheduleFetchState({
      loading: false,
      fetchError: false,
      hasMatchingPayload: true,
      hasPlan: true,
    }) === "SUCCESS_PLAN",
    "정상 조회 월표 존재"
  );
  assert(
    resolveMarshalScheduleFetchState({
      loading: false,
      fetchError: true,
      hasMatchingPayload: false,
      hasPlan: false,
    }) === "ERROR",
    "조회 실패"
  );
  assert(
    classifyScheduleFetchResult({
      requestId: 2,
      latestRequestId: 2,
      ok: true,
      payload: { year: 2099, month: 11 },
      year: 2099,
      month: 11,
    }) === "success",
    "월표 없는 정상 응답"
  );
  assert(
    classifyScheduleFetchResult({
      requestId: 2,
      latestRequestId: 2,
      ok: false,
      payload: { error: "boom" },
      year: 2099,
      month: 11,
    }) === "error",
    "HTTP 500"
  );
  assert(
    classifyScheduleFetchResult({
      requestId: 2,
      latestRequestId: 2,
      ok: false,
      networkError: true,
      payload: null,
      year: 2099,
      month: 11,
    }) === "error",
    "네트워크 오류"
  );
  assert(
    classifyScheduleFetchResult({
      requestId: 2,
      latestRequestId: 2,
      ok: true,
      payload: { year: 2099, month: 10 },
      year: 2099,
      month: 11,
    }) === "error",
    "잘못된 응답 year/month"
  );
  assert(
    classifyScheduleFetchResult({
      requestId: 1,
      latestRequestId: 2,
      ok: true,
      payload: { year: 2099, month: 10 },
      year: 2099,
      month: 10,
    }) === "stale",
    "빠른 월 이동 stale GET"
  );
  assert(
    nextFetchStateAfterLoad({
      previous: "ERROR",
      result: "success",
      hasPlan: true,
    }) === "SUCCESS_PLAN",
    "조회 실패 후 재시도 성공"
  );
  assert(
    nextFetchStateAfterLoad({
      previous: "LOADING",
      result: "stale",
      hasPlan: true,
    }) === "LOADING",
    "stale 응답은 로딩 유지"
  );
  assert(scheduleFetchFailureKind({ ok: false, payloadMatches: false }) === "http", "http kind");
  assert(
    scheduleFetchFailureKind({ networkError: true, payloadMatches: false }) === "network",
    "network kind"
  );
  assert(
    scheduleFetchFailureKind({ ok: true, payloadMatches: false }) === "mismatch",
    "mismatch kind"
  );
  assert(scheduleFetchErrorMessage("http").includes("실패"), "http 안내");
  assert(scheduleFetchErrorMessage("network").includes("네트워크"), "network 안내");
  assert(scheduleFetchErrorMessage("mismatch").includes("월과 다릅니다"), "mismatch 안내");
  assert(scheduleEmptyAllowed("SUCCESS_EMPTY"), "빈 월표 안내 허용");
  assert(!scheduleEmptyAllowed("ERROR"), "실패 시 빈 월표 안내 금지");
  assert(schedulePlanDisplayAllowed("SUCCESS_PLAN"), "성공 시 월표 표시");
  assert(!schedulePlanDisplayAllowed("ERROR"), "실패 시 이전 월표 표시 금지");
  assert(!scheduleWorkspaceVisible("ERROR"), "ERROR에서 달력/관리 패널 숨김");
  assert(scheduleWorkspaceVisible("SUCCESS_EMPTY"), "EMPTY에서 작업 영역 유지");
  assert(scheduleWorkspaceVisible("SUCCESS_PLAN"), "PLAN에서 작업 영역 유지");
  assert(scheduleWorkspaceVisible("LOADING"), "LOADING에서 기존 영역 유지");
  assert(
    shouldScrollPcDayDetail({ selectedDate: "2099-10-16", calendarDisplay: "block" }),
    "PC 달력 상세 스크롤"
  );
  assert(
    !shouldScrollPcDayDetail({ selectedDate: "2099-10-16", calendarDisplay: "none" }),
    "모바일 숨김 달력은 스크롤 없음"
  );
  assert(
    !shouldScrollPcDayDetail({ selectedDate: null, calendarDisplay: "block" }),
    "미선택 시 스크롤 없음"
  );
}

section("source contracts");
{
  const page = read("src/app/manage/marshals/schedule/page.tsx");
  const css = read("src/app/globals.css");
  const ui = read("src/lib/marshalScheduleUi.ts");
  assert(page.includes('data-marshal-schedule="calendar"'), "PC calendar");
  assert(page.includes('data-marshal-schedule="dense"'), "mobile dense");
  assert(page.includes("이월 대기"), "UI carry hint");
  assert(page.includes('aria-label="시작 순번"'), "시작 순번 라벨");
  assert(page.includes('aria-label="조출 인원"'), "조출 인원 라벨");
  assert(page.includes('aria-label="후출 인원"'), "후출 인원 라벨");
  assert(page.includes("월표 설정"), "설정 패널");
  assert(page.includes("DUTY_PANEL_TITLE"), "기존 벌당 패널 명칭");
  assert(page.includes("MarshalPenaltyOccurrencePanel"), "발생 벌당 패널");
  assert(page.includes("data-marshal-regen-banner"), "재생성 배너");
  assert(page.includes("대타 보정 관리"), "보정 패널");
  assert(page.includes("아직 생성된 마샬 월표가 없습니다"), "빈 월표 안내");
  assert(page.includes("월표 설정 열기"), "빈 월표 설정 버튼");
  assert(page.includes('data-marshal-open-settings="1"'), "설정 열기 마커");
  assert(page.includes('data-marshal-open-settings="toolbar"'), "툴바 설정 열기");
  assert(page.includes("openSettings"), "설정 열기 핸들러");
  assert(page.includes("matchesRequestedYearMonth"), "year/month 일치 가드");
  assert(page.includes('data-marshal-loading="1"'), "로딩 표시");
  assert(page.includes("data-marshal-fetch-state"), "fetch state 마커");
  assert(page.includes('data-marshal-fetch-error="1"'), "조회 실패 안내");
  assert(page.includes('data-marshal-retry-fetch="1"'), "읽기 전용 재시도");
  assert(page.includes('load("retry")'), "재시도는 GET만");
  assert(page.includes("classifyScheduleFetchResult"), "조회 결과 분류");
  assert(page.includes("scheduleEmptyAllowed"), "빈 월표는 성공만");
  assert(page.includes("scheduleWorkspaceVisible"), "ERROR 작업 영역 가드");
  assert(page.includes("showWorkspace"), "ERROR에서 board/패널 조건부 렌더");
  assert(page.includes("scheduleMutationBlocked"), "조회 중 변경 차단");
  assert(page.includes("load(\"month-change\")"), "월 변경 시 조회 리셋");
  assert(page.includes("clearDisplayedPlan"), "이전 월 데이터 제거");
  assert(page.includes('data-marshal-day-detail="pc"'), "PC 날짜 상세");
  assert(page.includes("scrollIntoView"), "PC 상세 즉시 표시");
  assert(page.includes("shouldScrollPcDayDetail"), "모바일 달력 스크롤 가드");
  assert(!page.includes("당일 투영은 다음 단계입니다"), "오래된 문구 없음");
  assert(page.includes("/api/marshals/plans?year="), "GET plans");
  assert(page.includes('method: "PUT"'), "PUT settings");
  assert(page.includes("/api/marshals/plans/generate"), "POST generate");
  assert(page.includes("/finalize"), "POST finalize");
  assert(page.includes("/api/marshals/penalties"), "POST penalty");
  assert(page.includes("shift: penaltyShift"), "UI penalty POST sends shift");
  assert(!/coverage:\s*penalty/.test(page), "UI penalty POST omits coverage");
  assert(page.includes("/api/marshals/credits"), "POST credit");
  assert(page.includes("/slots/${subSlotId}"), "PATCH slot");
  assert(page.includes("asSubstitute: true"), "substitute flag");
  assert(page.includes("applyCredit"), "credit flag");
  {
    const effect =
      page.split("useEffect(")[1]?.split("}, [load]")[0] || "";
    assert(effect.includes("load("), "mount 시 GET load");
    assert(!effect.includes("generate("), "조회 시 자동생성 없음");
  }
  {
    const empty =
      page.split('data-marshal-empty-plan="1"')[1]?.split("ms-board")[0] || "";
    assert(empty.includes("월표 설정 열기"), "빈 월표 상단 버튼");
    assert(!empty.includes("generate("), "빈 월표 버튼은 생성 호출 없음");
    assert(empty.includes("openSettings"), "빈 월표 버튼은 설정만 연다");
  }
  {
    const fail =
      page.split('data-marshal-fetch-error="1"')[1]?.split("actionError")[0] || "";
    assert(fail.includes("다시 조회"), "실패 시 재시도");
    assert(!fail.includes("아직 생성된 마샬 월표가 없습니다"), "실패 시 빈 월표 안내 없음");
    assert(!fail.includes("generate("), "재시도는 생성 호출 없음");
  }
  assert(css.includes(".ms-calendar"), "calendar css");
  assert(css.includes(".ms-dense"), "dense css");
  assert(
    /@media \(max-width: 719px\)[\s\S]*\.ms-calendar\s*\{\s*display:\s*none/m.test(css),
    "모바일에서 달력 숨김"
  );
  assert(
    /@media \(max-width: 719px\)[\s\S]*\.ms-dense\s*\{\s*display:\s*block/m.test(css),
    "모바일에서 dense 표시"
  );
  assert(!ui.includes("autoAssignEngine"), "ui helper 엔진 없음");
  assert(!ui.includes("generateMonthRotation"), "ui helper 순환 생성 없음");
  assert(!page.includes("generateMonthRotation"), "page 순환 엔진 없음");
}

if (failed > 0) {
  console.error(`\nFAIL ${failed} (passed ${passed})`);
  process.exit(1);
}
console.log(`\nOK ${passed}`);
