/**
 * 마샬 월표 모바일 엑셀형 그리드 P1 — 합성 데이터만 사용 (DB 접근 없음)
 * 실행: npm run test:marshal-month-mobile-grid-unit
 */
import fs from "node:fs";
import { occurrenceCalendarBadgeText } from "../src/lib/marshalPenaltyOccurrenceUi";
import path from "node:path";
import {
  buildMarshalMonthGridRows,
  buildRotationOrderMap,
  listMonthDayBoards,
  marshalGridEntryOrderText,
  marshalGridEntryText,
  marshalPlanStatusKind,
  marshalDayFlagBadges,
  msUntilNextSeoulMidnight,
  marshalMobileGridVisible,
  scheduleEmptyAllowed,
  scheduleWorkspaceVisible,
  buildMarshalDayBoard,
  seoulTodayYmd,
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
function section(t: string) {
  console.log("\n==", t, "==");
}

// 합성 마샬: 1~6 활성, 99 = 비활성(members 에 없음)
const NAMES: Record<number, string> = {
  1: "김하나",
  2: "이둘",
  3: "박셋째",
  4: "최넷",
  5: "정다섯",
  6: "남궁여섯째",
  99: "비활성마샬",
};
const members = [1, 2, 3, 4, 5, 6].map((caddyId, i) => ({
  profileId: 100 + caddyId,
  caddyId,
  rotationOrder: i + 1,
  name: NAMES[caddyId],
}));

let nextId = 1;
function slot(
  date: string,
  shift: "AM" | "PM",
  slotIndex: number,
  caddyId: number,
  source = "ROTATION",
  originalCaddyId?: number
): MarshalScheduleSlotView {
  return {
    id: nextId++,
    date,
    shift,
    slotIndex,
    caddyId,
    source,
    warning: null,
    note: null,
    caddy: { id: caddyId, name: NAMES[caddyId] },
    originalCaddy: originalCaddyId
      ? { id: originalCaddyId, name: NAMES[originalCaddyId] }
      : null,
  };
}

function ymd(y: number, m: number, d: number) {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** 순환 배치 + 예외 몇 개 */
function synthMonth(y: number, m: number, days: number, pmSlots = 1) {
  const slots: MarshalScheduleSlotView[] = [];
  let r = 0;
  for (let d = 1; d <= days; d++) {
    const date = ymd(y, m, d);
    if (d === 5) continue; // 5일: 전부 미배정
    const pick = () => (r++ % 6) + 1;
    slots.push(slot(date, "AM", 0, pick()));
    if (d !== 6) slots.push(slot(date, "AM", 1, pick())); // 6일 조출2 미배정
    for (let p = 0; p < pmSlots; p++) slots.push(slot(date, "PM", p, pick()));
  }
  return slots;
}

section("30일 월 (2026-11)");
{
  nextId = 1;
  const slots = synthMonth(2026, 11, 30);
  // 3일 조출1 대타 (원래 1 → 4)
  const s3 = slots.find((s) => s.date === "2026-11-03" && s.shift === "AM" && s.slotIndex === 0)!;
  s3.source = "SUBSTITUTE";
  s3.originalCaddy = { id: s3.caddyId, name: NAMES[s3.caddyId] };
  s3.caddyId = 4;
  s3.caddy = { id: 4, name: NAMES[4] };
  // 4일 후출 벌당
  const s4 = slots.find((s) => s.date === "2026-11-04" && s.shift === "PM")!;
  s4.source = "PENALTY";
  // 7일 조출2 비활성 마샬
  const s7 = slots.find((s) => s.date === "2026-11-07" && s.shift === "AM" && s.slotIndex === 1)!;
  s7.caddyId = 99;
  s7.caddy = { id: 99, name: NAMES[99] };
  // 8일 MANUAL
  const s8 = slots.find((s) => s.date === "2026-11-08" && s.shift === "PM")!;
  s8.source = "MANUAL";

  const days = listMonthDayBoards({ year: 2026, month: 11, slots });
  const rows = buildMarshalMonthGridRows({ days, members, todayYmd: "2026-11-10" });
  assert(rows.length === 30, "30행");
  assert(rows[0].ymd === "2026-11-01" && rows[0].weekdayLabel === "일", "11/1 일요일");
  assert(rows.filter((r) => r.isToday).length === 1 && rows[9].isToday, "오늘(10일)만 강조");
  assert(rows[0].isWeekend && !rows[1].isWeekend, "주말 표시");

  const r1 = rows[0];
  assert(r1.am1.entries[0].rotationOrder === 1 && r1.am1.entries[0].name === "김하나", "1일 조출1 = 1 김하나");
  assert(r1.am2.entries[0].rotationOrder === 2, "1일 조출2 = 2");
  assert(r1.pm.entries[0].rotationOrder === 3, "1일 후출 = 3");
  assert(marshalGridEntryText(r1.am1.entries[0]) === "1 김하나", "순번+이름 텍스트");

  const allEntries = rows.flatMap((r) => [...r.am1.entries, ...r.am2.entries, ...r.pm.entries]);
  const subs = allEntries.filter((e) => e.isSubstitute);
  assert(subs.length === 1 && subs[0].slotId === s3.id, "대타는 SUBSTITUTE 1건만");
  assert(subs[0].name === "최넷" && subs[0].rotationOrder === 4, "대타 칸 = 현재 근무자 순번·이름");
  assert(subs[0].originalName === NAMES[1], "대타 원래 근무자 이름 보존");
  assert(
    allEntries.filter((e) => e.source === "ROTATION").every((e) => !e.isSubstitute),
    "ROTATION 은 대타로 추정하지 않음"
  );
  assert(
    allEntries.filter((e) => e.source === "MANUAL" || e.source === "PENALTY").every((e) => !e.isSubstitute),
    "MANUAL/PENALTY 도 초록 아님"
  );
  const pen = rows[3].pm.entries[0];
  assert(pen.isPenalty && !pen.isSubstitute, "벌당 표시, 초록 아님");

  const r5 = rows[4];
  assert(
    r5.am1.entries.length === 0 && r5.am2.entries.length === 0 && r5.pm.entries.length === 0,
    "5일 전부 미배정"
  );
  assert(rows[5].am2.entries.length === 0 && rows[5].am1.entries.length === 1, "6일 조출2만 미배정");

  const inactive = rows[6].am2.entries[0];
  assert(inactive.name === "비활성마샬" && inactive.rotationOrder === null, "비활성 마샬 = 순번 null");
  assert(marshalGridEntryOrderText(inactive) === "–", "순번 없으면 중립 기호(임의 숫자 금지)");
  assert(marshalGridEntryText(inactive) === "비활성마샬", "순번 없으면 이름만");

  assert(allEntries.length === slots.length, "슬롯 누락 없음 (30일)");
}

section("31일 월 (2026-12) + 후출 2명");
{
  nextId = 1000;
  const slots = synthMonth(2026, 12, 31, 2);
  const days = listMonthDayBoards({ year: 2026, month: 12, slots });
  const rows = buildMarshalMonthGridRows({ days, members, todayYmd: "2026-11-10" });
  assert(rows.length === 31 && rows[30].ymd === "2026-12-31", "31행");
  assert(rows.every((r) => !r.isToday), "다른 달이면 오늘 강조 없음");
  assert(rows[0].pm.entries.length === 2, "후출 2명 같은 칸에 모두 표시");
  assert(
    rows[0].pm.entries[0].slotId < rows[0].pm.entries[1].slotId,
    "후출 slotIndex 순서 유지"
  );
  const all = rows.flatMap((r) => [...r.am1.entries, ...r.am2.entries, ...r.pm.entries]);
  assert(all.length === slots.length, "슬롯 누락 없음 (31일, 후출 2)");
}

section("조출 3명 이상 설정도 누락 없음");
{
  const slots = [
    slot("2026-11-02", "AM", 0, 1),
    slot("2026-11-02", "AM", 1, 2),
    slot("2026-11-02", "AM", 2, 3),
  ];
  const rows = buildMarshalMonthGridRows({
    days: listMonthDayBoards({ year: 2026, month: 11, slots }),
    members,
  });
  assert(rows[1].am1.entries.length === 1 && rows[1].am2.entries.length === 2, "조출2 칸에 나머지 쌓기");
}

section("순번 맵");
{
  const map = buildRotationOrderMap([
    { caddyId: 1, rotationOrder: 7 },
    { caddyId: 2, rotationOrder: 0 },
    { caddyId: 3, rotationOrder: Number.NaN },
  ]);
  assert(map.get(1) === 7, "정상 순번");
  assert(!map.has(2) && !map.has(3), "0/NaN 순번은 무시");
  assert(buildRotationOrderMap(null).size === 0, "members 없음");
}

section("월표 상태");
{
  assert(marshalPlanStatusKind(null) === "NONE", "월표 없음");
  assert(marshalPlanStatusKind({ status: "DRAFT" }) === "DRAFT", "DRAFT");
  assert(marshalPlanStatusKind({ status: "finalized" }) === "FINALIZED", "FINALIZED");
}

section("오늘(Asia/Seoul)");
{
  assert(seoulTodayYmd(new Date("2026-10-31T15:30:00Z")) === "2026-11-01", "UTC 15:30 → KST 다음날");
  assert(seoulTodayYmd(new Date("2026-10-31T14:59:00Z")) === "2026-10-31", "UTC 14:59 → KST 당일");
}

section("DayFlags 상태 배지 (기존 DayFlags 와 동일 조건)");
{
  const D = "2026-10-10";
  const sl = (o: Partial<MarshalScheduleSlotView>): MarshalScheduleSlotView => ({
    id: Math.floor(Math.random() * 1e9), date: D, shift: "AM", slotIndex: 0, caddyId: 1,
    source: "ROTATION", warning: null, note: null, caddy: { id: 1, name: "김하나" },
    originalCaddy: null, ...o,
  } as MarshalScheduleSlotView);
  const occ = (caddyId: number, name: string, src: string) => ({
    caddyId, status: "SCHEDULED", scheduledOn: D, scheduleSource: src, caddy: { name },
  });
  const flags = (input: Parameters<typeof buildMarshalDayBoard>[0]) =>
    marshalDayFlagBadges(buildMarshalDayBoard(input), occurrenceCalendarBadgeText);
  // 기존 DayFlags JSX 를 그대로 옮긴 참조 구현
  const ref = (day: ReturnType<typeof buildMarshalDayBoard>) => {
    const o = day.occurrenceBadges || [];
    const r: string[] = [];
    if (day.hasWarning) r.push("경고");
    if (day.hasSubstitute) r.push("대타");
    if (o.length === 0 && day.hasPenalty) r.push("벌당");
    for (const b of o.slice(0, 2)) r.push(occurrenceCalendarBadgeText(b));
    if (o.length > 2) r.push(`전일 +${o.length - 2}`);
    return r;
  };
  const kinds = (f: ReturnType<typeof flags>) => f.map((x) => x.kind).join(",");
  assert(flags({ ymd: D, slots: [sl({})] }).length === 0, "일반 근무만 → 배지 없음");
  assert(kinds(flags({ ymd: D, slots: [sl({ warning: "연속" })] })) === "warn", "warning → 경고");
  assert(kinds(flags({ ymd: D, slots: [sl({ source: "SUBSTITUTE" })] })) === "sub", "SUBSTITUTE → 대타");
  assert(
    kinds(flags({ ymd: D, slots: [sl({ source: "ROTATION", originalCaddy: { id: 2, name: "이둘" } })] })) === "sub",
    "originalCaddy 있는 슬롯 → 대타 (DayFlags 원래 조건 유지)"
  );
  assert(kinds(flags({ ymd: D, slots: [sl({ source: "PENALTY" })] })) === "penalty", "PENALTY 슬롯 → 벌당");
  assert(
    kinds(flags({ ymd: D, slots: [sl({})], penalties: [{ date: D }] } as never)) === "penalty",
    "벌당 기록(penalties) → 벌당"
  );
  const o1 = flags({ ymd: D, slots: [sl({ source: "PENALTY" })], occurrences: [occ(3, "박셋째", "AUTO")] } as never);
  assert(kinds(o1) === "occ", "발생 기록 있으면 '벌당' 대신 발생 기록 배지만 (DayFlags 동일)");
  assert(o1[0].text === "박셋째 전일·" + occurrenceCalendarBadgeText({ name: "박셋째", source: "AUTO" }).split("전일·")[1], "발생 기록 문구 = occurrenceCalendarBadgeText");
  assert(o1[0].srText.startsWith("벌당 발생 기록"), "발생 기록 스크린리더 문구 구분");
  assert(o1[0].kind !== "penalty", "벌당 발생 기록 ≠ 벌당 근무 배정");
  const o3 = flags({ ymd: D, slots: [], occurrences: [occ(1, "가", "AUTO"), occ(2, "나", "MANUAL"), occ(3, "다", "AUTO"), occ(4, "라", "AUTO")] } as never);
  assert(kinds(o3) === "occ,occ,occ-more" && o3[2].text === "전일 +2", "발생 기록 3건 이상 → 2개 + 전일 +N");
  assert(o3[1].source === "MANUAL", "수동 발생 기록 source 보존");
  const cancelled = flags({ ymd: D, slots: [], occurrences: [{ ...occ(1, "가", "AUTO"), status: "CANCELLED" }] } as never);
  assert(cancelled.length === 0, "SCHEDULED 아닌 발생 기록은 표시 안 함");
  const all = buildMarshalDayBoard({ ymd: D, slots: [sl({ warning: "w", source: "SUBSTITUTE" }), sl({ source: "PENALTY", shift: "PM" })], occurrences: [occ(5, "정다섯", "MANUAL")] } as never);
  assert(JSON.stringify(marshalDayFlagBadges(all, occurrenceCalendarBadgeText).map((x) => x.text)) === JSON.stringify(ref(all)), "모든 플래그 조합: 참조 DayFlags 와 텍스트·순서 동일");
  for (const combo of [[], [sl({ warning: "x" })], [sl({ source: "PENALTY" })], [sl({ originalCaddy: { id: 9, name: "x" } })]]) {
    const b = buildMarshalDayBoard({ ymd: D, slots: combo });
    assert(JSON.stringify(marshalDayFlagBadges(b, occurrenceCalendarBadgeText).map((x) => x.text)) === JSON.stringify(ref(b)), `참조 DayFlags 일치 (${combo.length}슬롯)`);
  }
}

section("자정 갱신 타이머");
{
  assert(msUntilNextSeoulMidnight(new Date("2026-10-31T14:59:00Z")) === 60_000, "KST 23:59 → 60초");
  assert(msUntilNextSeoulMidnight(new Date("2026-10-31T15:00:00Z")) === 86_400_000, "KST 00:00 → 24시간");
  assert(msUntilNextSeoulMidnight(new Date("2026-10-31T14:59:59.900Z")) === 1000, "최소 1초");
}

section("월표 상태별 모바일 그리드 표시 (LOADING / SUCCESS_EMPTY / SUCCESS_PLAN / ERROR)");
{
  const plan = { status: "DRAFT" };
  assert(!marshalMobileGridVisible("LOADING", plan), "LOADING → 그리드 숨김");
  assert(!marshalMobileGridVisible("SUCCESS_EMPTY", null), "SUCCESS_EMPTY(월표 없음) → 그리드 숨김");
  assert(scheduleEmptyAllowed("SUCCESS_EMPTY"), "SUCCESS_EMPTY → 기존 빈 월표 안내 유지");
  assert(scheduleWorkspaceVisible("SUCCESS_EMPTY"), "SUCCESS_EMPTY → 월표 설정 영역 유지");
  assert(marshalMobileGridVisible("SUCCESS_PLAN", plan), "SUCCESS_PLAN + DRAFT → 표시");
  assert(marshalMobileGridVisible("SUCCESS_PLAN", { status: "FINALIZED" }), "SUCCESS_PLAN + FINALIZED → 표시");
  assert(!marshalMobileGridVisible("SUCCESS_PLAN", null), "SUCCESS_PLAN 인데 plan 없음 → 숨김");
  assert(!marshalMobileGridVisible("ERROR", plan), "ERROR → 숨김");
  assert(!scheduleWorkspaceVisible("ERROR"), "ERROR → 기존과 같이 작업영역 숨김");
  // 월표가 있어도 일부 슬롯이 비면 미배정 유지
  const rows = buildMarshalMonthGridRows({ days: listMonthDayBoards({ year: 2026, month: 10, slots: [
    { id: 1, date: "2026-10-01", shift: "AM", slotIndex: 0, caddyId: 1, source: "ROTATION", warning: null, note: null, caddy: { id: 1, name: "김하나" }, originalCaddy: null } as MarshalScheduleSlotView,
  ] }) });
  assert(rows[0].am1.entries.length === 1 && rows[0].am2.entries.length === 0 && rows[0].pm.entries.length === 0, "부분 빈 슬롯 → 빈 칸(미배정) 유지");
  const comp0 = fs.readFileSync(path.resolve("src/components/manage/MarshalMonthMobileGrid.tsx"), "utf8");
  assert(comp0.includes("미배정"), "빈 칸 미배정 문구 유지");
}

section("source contracts");
{
  const read = (rel: string) => fs.readFileSync(path.resolve(rel), "utf8");
  const page = read("src/app/manage/marshals/schedule/page.tsx");
  const comp = read("src/components/manage/MarshalMonthMobileGrid.tsx");
  const css = read("src/app/globals.css");
  assert(page.includes('data-marshal-schedule="calendar"'), "PC 달력 유지");
  assert(page.includes("renderDayDetail(row.board"), "모바일 행 → 기존 일자 상세(교체) 재사용");
  assert(comp.includes('data-marshal-schedule="dense"'), "모바일 그리드 마커");
  const xg = css.slice(css.indexOf("마샬 월표 모바일 엑셀형"));
  assert(!/ellipsis/.test(xg), "그리드 CSS 말줄임 없음");
  assert(!/fetch\(/.test(comp), "그리드 컴포넌트는 새 API 호출 없음");
  assert(comp.includes("marshalDayFlagBadges(row.board, occurrenceCalendarBadgeText)"), "그리드가 DayFlags 동일 헬퍼 사용");
  assert(comp.includes("벌당 근무 배정"), "벌 태그 스크린리더 문구 = 벌당 근무 배정");
  assert(comp.includes("visibilitychange") && comp.includes("msUntilNextSeoulMidnight"), "오늘 자정/복귀 갱신");
  assert(/marshalMobileGridVisible\(fetchState, dataForMonth\?\.plan\) \? \(\s*<MarshalMonthMobileGrid/.test(page), "page: 그리드는 marshalMobileGridVisible 조건에서만");
  assert(page.includes('data-marshal-empty-plan="1"') && page.includes("월표 설정 열기"), "빈 월표 안내·설정 버튼 유지");
  assert(comp.includes(".vh-mobile-bar") && comp.includes("--ms-xg-sticky-top"), "sticky top = 앱 상단 바 높이");
  assert(/\.ms-xg \.ms-xg-head \{[^}]*top: var\(--ms-xg-sticky-top\)/.test(css), "그리드 헤더 top 변수 사용");
  assert(page.includes("function DayFlags") && page.includes("<DayFlags day={day} />"), "PC 달력 DayFlags 유지");
}

console.log(`\n${failed ? "FAIL" : "PASS"} ${failed} (passed ${passed})`);
if (failed) process.exit(1);
