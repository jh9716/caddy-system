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
  planStatusLabel,
  shiftYearMonth,
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
  assert(page.includes("벌당 관리"), "벌당 패널");
  assert(page.includes("대타 보정 관리"), "보정 패널");
  assert(page.includes("아직 생성된 마샬 월표가 없습니다"), "빈 월표 안내");
  assert(!page.includes("당일 투영은 다음 단계입니다"), "오래된 문구 없음");
  assert(page.includes("/api/marshals/plans?year="), "GET plans");
  assert(page.includes('method: "PUT"'), "PUT settings");
  assert(page.includes("/api/marshals/plans/generate"), "POST generate");
  assert(page.includes("/finalize"), "POST finalize");
  assert(page.includes("/api/marshals/penalties"), "POST penalty");
  assert(page.includes("/api/marshals/credits"), "POST credit");
  assert(page.includes("/slots/${subSlotId}"), "PATCH slot");
  assert(page.includes("asSubstitute: true"), "substitute flag");
  assert(page.includes("applyCredit"), "credit flag");
  {
    const effect =
      page.split("useEffect(")[1]?.split("}, [load]")[0] || "";
    assert(effect.includes("load()"), "mount 시 GET load");
    assert(!effect.includes("generate("), "조회 시 자동생성 없음");
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
