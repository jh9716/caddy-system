/**
 * 당번·마샬·조장 Google Spreadsheet 입력 경로 타깃 테스트
 * 실행: npm run test:ops-duty-sheet-unit
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as XLSX from "xlsx";
import {
  buildDutyMarshalLeaderTestBuffer,
  parseDutyMarshalLeaderWorkbook,
} from "../src/lib/dutyMarshalLeaderParser";
import { matchDutyEntriesToCaddies } from "../src/lib/dailyOpsDuty";
import {
  listDailyOpsDuties,
  replaceDailyOpsDuties,
} from "../src/lib/dailyOpsDutyService";
import { isLocalDatabaseUrl } from "../src/lib/dbSafety";
import {
  fetchPublishedOpsDutySheets,
  invalidateOpsDutySheetCache,
  workbookToOpsDutySheets,
} from "../src/lib/opsDutySheetFetch";
import {
  OpsDutySheetError,
  buildOpsDutySheetSlots,
  buildOpsDutySheetTestSheets,
  normalizeOpsDutyRoleKey,
  opsDutySheetApplyBlockReason,
  parseOpsDutySheetsForDate,
  type OpsDutySheet,
  type OpsDutySheetTestDayNames,
} from "../src/lib/opsDutySheetParser";

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

function ymd(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function addDays(start: string, n: number): string {
  const [y, m, d] = start.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

function week(start: string, count = 7): string[] {
  return Array.from({ length: count }, (_, i) => addDays(start, i));
}

function eightNames(prefix: string): OpsDutySheetTestDayNames {
  return {
    당번_조출_1: `${prefix}당1`,
    당번_조출_2: `${prefix}당2`,
    당번_후출_1: `${prefix}후1`,
    당번_후출_2: `${prefix}후2`,
    마샬_조출_1: `${prefix}마1`,
    마샬_조출_2: `${prefix}마2`,
    마샬_후출_1: `${prefix}마후`,
    조장_1: `${prefix}조장`,
  };
}

function byKey(entries: { roleKey: string; rawName: string }[]) {
  return Object.fromEntries(entries.map((e) => [e.roleKey, e.rawName]));
}

function expectThrow(code: string, fn: () => unknown, msg: string) {
  try {
    fn();
    assert(false, msg);
  } catch (e) {
    assert(
      e instanceof OpsDutySheetError && e.code === code,
      msg
    );
  }
}

const W1 = week("2026-09-07");
const W2 = week("2026-09-14");
const FIRST = eightNames("앞");
const LAST = eightNames("뒤");

const OPS_TAB = {
  name: "0907~0920",
  startDate: "2026-09-07",
  week1Dates: W1,
  week2Dates: W2,
  week1Names: [FIRST, {}, {}, {}, {}, {}, {}],
  week2Names: [{}, {}, {}, {}, {}, {}, LAST],
};

const TEMPLATE_TAB = {
  name: "복사용",
  startDate: "2026-09-02",
  week1Dates: week("2026-09-02"),
  week2Dates: week("2026-09-09"),
  week1Names: [eightNames("템플릿"), {}, {}, {}, {}, {}, {}],
  week2Names: [{}, {}, {}, {}, {}, {}, eightNames("템플릿뒤")],
};

const GUIDE_TAB = {
  name: "사용안내",
  startDate: "2026-01-01",
  week1Dates: week("2026-01-01"),
  week2Dates: week("2026-01-08"),
  week1Names: [eightNames("안내"), {}, {}, {}, {}, {}, {}],
  week2Names: [],
};

section("역할 normalize — 8개만 정확 매핑, 섹션 제목 제외");
{
  assert(normalizeOpsDutyRoleKey("당번 · 조출 1") === "당번_조출_1", "당번 · 조출 1");
  assert(normalizeOpsDutyRoleKey("당번·조출1") === "당번_조출_1", "가운데점/공백 접기");
  assert(normalizeOpsDutyRoleKey("당번_조출_2") === "당번_조출_2", "underscore 키");
  assert(normalizeOpsDutyRoleKey("  마샬  ·  후출  1 ") === "마샬_후출_1", "마샬 후출 1");
  assert(normalizeOpsDutyRoleKey("조장") === "조장_1", "조장");
  assert(normalizeOpsDutyRoleKey("조장_1") === "조장_1", "조장_1");
  assert(normalizeOpsDutyRoleKey("당번") === null, "섹션 당번 제외");
  assert(normalizeOpsDutyRoleKey("마샬") === null, "섹션 마샬 제외");
  assert(normalizeOpsDutyRoleKey("1구간 운영") === null, "1구간 운영 제외");
  assert(normalizeOpsDutyRoleKey("2구간 운영") === null, "2구간 운영 제외");
  assert(normalizeOpsDutyRoleKey("구분") === null, "구분 제외");
}

section("복사용/사용안내 제외 + 임의 탭 이름에서도 날짜 검색");
{
  const sheets = buildOpsDutySheetTestSheets([
    TEMPLATE_TAB,
    GUIDE_TAB,
    { ...OPS_TAB, name: "9월2차" },
  ]);
  const first = parseOpsDutySheetsForDate(sheets, "2026-09-07");
  assert(first.sheetName === "9월2차", "운영 탭 이름 9월2차");
  assert(byKey(first.entries)["당번_조출_1"] === "앞당1", "앞 7일 첫째 날");
  assert(first.entries.length === 8, "8역할");
  expectThrow(
    "ops_duty_sheet_date_not_found",
    () => parseOpsDutySheetsForDate(sheets, "2026-09-02"),
    "복사용 시작일 2026-09-02는 운영 데이터가 아님"
  );
  expectThrow(
    "ops_duty_sheet_date_not_found",
    () => parseOpsDutySheetsForDate(sheets, "2026-01-01"),
    "사용안내 날짜는 운영 데이터가 아님"
  );
}

section("한 탭 14일 중 앞 7일/뒤 7일 + 역할 8개");
{
  const sheets = buildOpsDutySheetTestSheets([TEMPLATE_TAB, OPS_TAB, GUIDE_TAB]);
  const d07 = parseOpsDutySheetsForDate(sheets, "2026-09-07");
  const d20 = parseOpsDutySheetsForDate(sheets, "2026-09-20");
  assert(
    OPS_TAB.week1Dates[0] === "2026-09-07" && OPS_TAB.week2Dates[6] === "2026-09-20",
    "fixture 14일 양끝"
  );
  assert(d07.entries.map((e) => e.roleKey).join(",") ===
    "당번_조출_1,당번_조출_2,당번_후출_1,당번_후출_2,마샬_조출_1,마샬_조출_2,마샬_후출_1,조장_1",
    "8 roleKey 순서");
  assert(
    d07.entries.map((e) => e.rawName).join(",") ===
      "앞당1,앞당2,앞후1,앞후2,앞마1,앞마2,앞마후,앞조장",
    "앞 7일 첫째 날 이름"
  );
  assert(
    d20.entries.map((e) => e.rawName).join(",") ===
      "뒤당1,뒤당2,뒤후1,뒤후2,뒤마1,뒤마2,뒤마후,뒤조장",
    "뒤 7일 마지막 날 이름"
  );
  const mid = parseOpsDutySheetsForDate(sheets, "2026-09-13");
  assert(mid.entries.length === 0, "이름 없는 중간일은 빈 entries");
}

section("색상/서식과 무관 — 셀 값만");
{
  const sheets = buildOpsDutySheetTestSheets([{ ...OPS_TAB, name: "무슨 이름" }]);
  const wb = XLSX.utils.book_new();
  for (const sheet of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(sheet.matrix);
    const addr = XLSX.utils.encode_cell({ r: 7, c: 2 });
    if (ws[addr]) {
      (ws[addr] as XLSX.CellObject).s = {
        fill: { fgColor: { rgb: "FF0000" } },
        font: { bold: true, color: { rgb: "0000FF" } },
      } as XLSX.CellObject["s"];
    }
    XLSX.utils.book_append_sheet(wb, ws, sheet.name.slice(0, 31));
  }
  const buf = Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
  const roundtrip = workbookToOpsDutySheets(buf);
  const parsed = parseOpsDutySheetsForDate(roundtrip, "2026-09-07");
  assert(parsed.entries.length === 8, "스타일이 있어도 8명");
  assert(parsed.entries[0]?.rawName === "앞당1", "값만 사용");
}

section("날짜가 다른 탭으로 이동해도 검색");
{
  const moved = buildOpsDutySheetTestSheets([
    TEMPLATE_TAB,
    GUIDE_TAB,
    {
      name: "0921~1004",
      startDate: "2026-09-07",
      week1Dates: W1,
      week2Dates: W2,
      week1Names: [FIRST, {}, {}, {}, {}, {}, {}],
      week2Names: [{}, {}, {}, {}, {}, {}, LAST],
    },
  ]);
  const parsed = parseOpsDutySheetsForDate(moved, "2026-09-07");
  assert(parsed.sheetName === "0921~1004", "이동한 탭에서 날짜 검색");
  assert(parsed.entries[0]?.rawName === "앞당1", "이동 후에도 이름");
}

section("중복 날짜 차단");
{
  const dup = buildOpsDutySheetTestSheets([
    OPS_TAB,
    {
      name: "다른운영탭",
      startDate: "2026-09-07",
      week1Dates: W1,
      week2Dates: W2,
      week1Names: [eightNames("중복"), {}, {}, {}, {}, {}, {}],
      week2Names: [],
    },
  ]);
  expectThrow(
    "ops_duty_sheet_duplicate_date",
    () => parseOpsDutySheetsForDate(dup, "2026-09-07"),
    "운영 탭 두 곳의 같은 날짜는 차단"
  );
}

section("역할 중복 차단");
{
  const matrix = buildOpsDutySheetTestSheets([OPS_TAB])[0].matrix;
  const 조장Rows: number[] = [];
  for (let r = 0; r < matrix.length; r++) {
    if (String(matrix[r]?.[1] || "").trim() === "조장") 조장Rows.push(r);
  }
  assert(조장Rows.length >= 2, "섹션 조장 + 역할 조장 행이 있음");
  matrix[조장Rows[0]][2] = "조장이름A";
  matrix[조장Rows[1]][2] = "조장이름B";
  expectThrow(
    "ops_duty_sheet_duplicate_role",
    () => parseOpsDutySheetsForDate([{ name: "0907~0920", matrix }], "2026-09-07"),
    "같은 날짜 조장 두 칸은 역할 중복"
  );
}

section("동명이인/미매칭 apply 차단");
{
  const sheets = buildOpsDutySheetTestSheets([OPS_TAB]);
  const parsed = parseOpsDutySheetsForDate(sheets, "2026-09-07");
  const dupMatch = matchDutyEntriesToCaddies(parsed.entries, [
    { id: 1, name: "앞당1", employmentStatus: "ACTIVE" },
    { id: 2, name: "앞당1", employmentStatus: "ACTIVE" },
    { id: 3, name: "앞당2", employmentStatus: "ACTIVE" },
    { id: 4, name: "앞후1", employmentStatus: "ACTIVE" },
    { id: 5, name: "앞후2", employmentStatus: "ACTIVE" },
    { id: 6, name: "앞마1", employmentStatus: "ACTIVE" },
    { id: 7, name: "앞마2", employmentStatus: "ACTIVE" },
    { id: 8, name: "앞마후", employmentStatus: "ACTIVE" },
    { id: 9, name: "앞조장", employmentStatus: "ACTIVE" },
  ]);
  assert(
    dupMatch.reviews.some((r) => r.rawName === "앞당1" && /임의 매칭 금지/.test(r.reason)),
    "동명이인은 review"
  );
  assert(
    opsDutySheetApplyBlockReason(dupMatch) !== null,
    "동명이인 preview는 apply 차단"
  );

  const missing = matchDutyEntriesToCaddies(parsed.entries, [
    { id: 3, name: "앞당2", employmentStatus: "ACTIVE" },
  ]);
  assert(missing.reviews.some((r) => r.rawName === "앞당1"), "미매칭 review");
  assert(opsDutySheetApplyBlockReason(missing) !== null, "미매칭 apply 차단");

  const okCaddies = parsed.entries.map((e, i) => ({
    id: i + 1,
    name: e.rawName,
    employmentStatus: "ACTIVE" as const,
  }));
  const ok = matchDutyEntriesToCaddies(parsed.entries, okCaddies);
  assert(ok.matched.length === 8 && ok.reviews.length === 0, "8명 exact ACTIVE");
  assert(opsDutySheetApplyBlockReason(ok) === null, "정상 매칭은 apply 가능");
  const slots = buildOpsDutySheetSlots({
    entries: parsed.entries,
    matched: ok.matched,
    reviews: ok.reviews,
  });
  assert(slots.length === 8 && slots.every((s) => s.status === "matched"), "8슬롯 매칭 성공");
}

section("기존 Excel parser regression");
{
  const buf = buildDutyMarshalLeaderTestBuffer(
    ["2026-08-19", "2026-08-17", "2026-08-18"],
    [
      { key: "당번_조출_1", values: ["월당번", "조출당1", "화당번"] },
      { key: "당번_조출_2", values: ["", "조출당2", ""] },
      { key: "당번_후출_1", values: ["", "후출당1", ""] },
      { key: "당번_후출_2", values: ["", "후출당2", ""] },
      { key: "마샬_조출_1", values: ["", "조출마1", ""] },
      { key: "마샬_조출_2", values: ["", "조출마2", ""] },
      { key: "마샬_후출_1", values: ["", "후출마1", ""] },
      { key: "조장_1", values: ["", "조장A", ""] },
    ]
  );
  const sunish = parseDutyMarshalLeaderWorkbook(buf, "2026-08-17");
  assert(sunish.entries.length === 8, "Excel 선택일 8명");
  assert(
    sunish.entries.map((e) => e.rawName).join(",") ===
      "조출당1,조출당2,후출당1,후출당2,조출마1,조출마2,후출마1,조장A",
    "Excel 역할별 이름 유지"
  );
}

section("소스 가드 — persist/offSheet/Excel 경로 유지");
{
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
  const offFetch = read("src/lib/offSheetFetch.ts");
  const persist = read("src/lib/quickBoardMutationApply.ts");
  const pipeline = read("src/lib/boardMutationPipeline.ts");
  const quickRoute = read("src/app/api/assignments/reflow/quick-mutation/route.ts");
  const excelPreview = read("src/app/api/daily-ops-duties/preview/route.ts");
  const excelApply = read("src/app/api/daily-ops-duties/apply/route.ts");
  const page = read("src/app/manage/assignments/page.tsx");
  const engine = read("src/lib/autoAssignEngine.ts");
  assert(!/opsDutySheet/.test(offFetch), "offSheetFetch 미변경(opsDutySheet 없음)");
  assert(!/opsDutySheet/.test(persist), "quickBoardMutationApply에 Google ops duty fetch 없음");
  assert(!/opsDutySheet/.test(pipeline), "boardMutationPipeline에 ops duty sheet 없음");
  assert(!/opsDutySheet/.test(quickRoute), "quick-mutation route에 ops duty sheet 없음");
  assert(
    /parseDutyMarshalLeaderWorkbook/.test(excelPreview) &&
      /parseDutyMarshalLeaderWorkbook/.test(excelApply),
    "기존 Excel preview/apply 유지"
  );
  assert(
    /운영배치 불러오기/.test(page) &&
      /당번·마샬·조장 Excel/.test(page) &&
      /\/api\/daily-ops-duties\/sheet-preview/.test(page) &&
      /\/api\/daily-ops-duties\/preview/.test(page),
    "Excel + Spreadsheet 둘 다 UI에 존재"
  );
  assert(!/opsDutySheet/.test(engine), "autoAssignEngine 미변경");
}

async function liveAndLocal() {
  section("Spreadsheet fetch + 실제 export 파싱");
  invalidateOpsDutySheetCache();
  let liveSheets: OpsDutySheet[] | null = null;
  try {
    liveSheets = await fetchPublishedOpsDutySheets({ force: true, timeoutMs: 20_000 });
    const names = liveSheets.map((s) => s.name);
    assert(names.includes("복사용") && names.includes("사용안내"), "live 탭 복사용/사용안내 존재");
    assert(
      names.some((n) => n !== "복사용" && n !== "사용안내"),
      "live 운영 탭 존재"
    );
    expectThrow(
      "ops_duty_sheet_date_not_found",
      () => parseOpsDutySheetsForDate(liveSheets!, "2026-09-02"),
      "live 복사용 2026-09-02는 운영 날짜가 아님"
    );
    const live07 = parseOpsDutySheetsForDate(liveSheets, "2026-09-07");
    assert(live07.sheetName !== "복사용" && live07.sheetName !== "사용안내", "09-07은 운영 탭");
    const live20 = parseOpsDutySheetsForDate(liveSheets, "2026-09-20");
    assert(live20.sheetName === live07.sheetName, "같은 14일 탭에서 뒤 7일도 파싱");
    console.log("  live fetch sheets:", names.join(" | "));
    console.log("  live 2026-09-07 tab:", live07.sheetName, "entries", live07.entries.length);
  } catch (e) {
    assert(false, `live fetch/parse: ${e instanceof Error ? e.message : e}`);
  }

  const rawPath = "/tmp/ops-duty-sheet/raw.xlsx";
  try {
    const fromFile = workbookToOpsDutySheets(readFileSync(rawPath));
    parseOpsDutySheetsForDate(fromFile, "2026-09-14");
    assert(true, "다운로드 xlsx 뒤 7일 시작일 파싱");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      assert(true, "다운로드 xlsx 없음 — live fetch로 대체");
    } else {
      assert(false, `raw xlsx parse: ${e instanceof Error ? e.message : e}`);
    }
  }

  section("apply 후 DailyOpsDuty 조회 결과 동일 (local DB)");
  const url = process.env.DATABASE_URL || "";
  if (!isLocalDatabaseUrl(url)) {
    console.log("  (skip local apply — DATABASE_URL is not caddy_local)");
    return;
  }
  const { prisma } = await import("../src/lib/prisma");
  const DATE = "2099-09-07";
  const active = await prisma.caddy.findMany({
    where: { employmentStatus: "ACTIVE" },
    select: { id: true, name: true, employmentStatus: true },
    orderBy: { id: "asc" },
    take: 8,
  });
  if (active.length < 8) {
    assert(false, "local ACTIVE 캐디 8명 필요");
    return;
  }
  const names: OpsDutySheetTestDayNames = {
    당번_조출_1: active[0].name,
    당번_조출_2: active[1].name,
    당번_후출_1: active[2].name,
    당번_후출_2: active[3].name,
    마샬_조출_1: active[4].name,
    마샬_조출_2: active[5].name,
    마샬_후출_1: active[6].name,
    조장_1: active[7].name,
  };
  const fixture = buildOpsDutySheetTestSheets([
    {
      name: "2099테스트",
      startDate: DATE,
      week1Dates: week(DATE),
      week2Dates: week(addDays(DATE, 7)),
      week1Names: [names, {}, {}, {}, {}, {}, {}],
      week2Names: [],
    },
  ]);
  const parsed = parseOpsDutySheetsForDate(fixture, DATE);
  const matched = matchDutyEntriesToCaddies(parsed.entries, active);
  assert(matched.reviews.length === 0 && matched.matched.length === 8, "local 8명 매칭");
  const previous = await listDailyOpsDuties(DATE);
  try {
    const saved = await replaceDailyOpsDuties({
      date: DATE,
      matched: matched.matched,
      confirmReplace: true,
    });
    const listed = await listDailyOpsDuties(DATE);
    assert(listed.length === saved.saved.length, "apply 후 list 건수 동일");
    assert(
      listed
        .map((r) => `${r.roleKey}:${r.caddyId}:${r.rawName}`)
        .sort()
        .join("|") ===
        matched.matched
          .map((r) => `${r.roleKey}:${r.caddyId}:${r.rawName}`)
          .sort()
          .join("|"),
      "apply 후 DailyOpsDuty 조회 = matched"
    );
  } finally {
    await replaceDailyOpsDuties({
      date: DATE,
      matched: previous.map((row) => ({
        role: row.role,
        roleKey: row.roleKey,
        caddyId: row.caddyId,
        rawName: row.rawName,
        name: row.name,
      })),
      confirmReplace: true,
    });
  }
}

liveAndLocal()
  .then(() => {
    console.log(`\nDONE: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
