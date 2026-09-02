/**
 * 가용 불러오기 운영배치 Spreadsheet 자동동기화 타깃 테스트
 * 실행: npm run test:ops-duty-sheet-autosync-unit
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isLocalDatabaseUrl } from "../src/lib/dbSafety";
import {
  listDailyOpsDuties,
  replaceDailyOpsDuties,
} from "../src/lib/dailyOpsDutyService";
import { loadAvailabilityForDate } from "../src/lib/availabilityService";
import {
  invalidateOpsDutySheetCache,
  OpsDutySheetError,
  setPublishedOpsDutySheetLoaderForTests,
} from "../src/lib/opsDutySheetFetch";
import {
  buildOpsDutySheetTestSheets,
  isOpsDutySheetAutoApplyReady,
  type OpsDutySheetTestDayNames,
} from "../src/lib/opsDutySheetParser";
import { syncOpsDutySheetOnAvailabilityLoad } from "../src/lib/opsDutySheetSync";
import { matchDutyEntriesToCaddies } from "../src/lib/dailyOpsDuty";

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

function addDays(start: string, n: number): string {
  const [y, m, d] = start.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

function week(start: string, count = 7): string[] {
  return Array.from({ length: count }, (_, i) => addDays(start, i));
}

function namesFromCaddies(
  rows: Array<{ name: string }>
): OpsDutySheetTestDayNames {
  return {
    당번_조출_1: rows[0].name,
    당번_조출_2: rows[1].name,
    당번_후출_1: rows[2].name,
    당번_후출_2: rows[3].name,
    마샬_조출_1: rows[4].name,
    마샬_조출_2: rows[5].name,
    마샬_후출_1: rows[6].name,
    조장_1: rows[7].name,
  };
}

section("자동 apply는 8명 exact ACTIVE만 허용");
{
  const entries = [
    { kind: "duty_am" as const, roleKey: "당번_조출_1", rawName: "가" },
    { kind: "duty_am" as const, roleKey: "당번_조출_2", rawName: "나" },
    { kind: "duty_pm" as const, roleKey: "당번_후출_1", rawName: "다" },
    { kind: "duty_pm" as const, roleKey: "당번_후출_2", rawName: "라" },
    { kind: "marshal_am" as const, roleKey: "마샬_조출_1", rawName: "마" },
    { kind: "marshal_am" as const, roleKey: "마샬_조출_2", rawName: "바" },
    { kind: "marshal_pm" as const, roleKey: "마샬_후출_1", rawName: "사" },
    { kind: "leader" as const, roleKey: "조장_1", rawName: "아" },
  ];
  const caddies = entries.map((e, i) => ({
    id: i + 1,
    name: e.rawName,
    employmentStatus: "ACTIVE" as const,
  }));
  const ok = matchDutyEntriesToCaddies(entries, caddies);
  assert(
    isOpsDutySheetAutoApplyReady({
      entries,
      matched: ok.matched,
      reviews: ok.reviews,
    }),
    "8명 매칭은 자동 apply 가능"
  );
  const missing = matchDutyEntriesToCaddies(entries.slice(0, 7), caddies);
  assert(
    !isOpsDutySheetAutoApplyReady({
      entries: entries.slice(0, 7),
      matched: missing.matched,
      reviews: missing.reviews,
    }),
    "7명은 자동 apply 불가"
  );
  const review = matchDutyEntriesToCaddies(entries, [
    ...caddies.slice(1),
    { id: 99, name: "없는사람", employmentStatus: "ACTIVE" },
  ]);
  assert(
    !isOpsDutySheetAutoApplyReady({
      entries,
      matched: review.matched,
      reviews: review.reviews,
    }),
    "미매칭은 자동 apply 불가"
  );
}

section("소스 가드 — persist/quick-mutation/Excel/수동 UI 유지");
{
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
  const persist = read("src/lib/quickBoardMutationApply.ts");
  const pipeline = read("src/lib/boardMutationPipeline.ts");
  const quick = read("src/app/api/assignments/reflow/quick-mutation/route.ts");
  const reflow = read("src/app/api/assignments/reflow/route.ts");
  const draft = read("src/app/api/assignments/draft/route.ts");
  const service = read("src/lib/availabilityService.ts");
  const preview = read("src/app/api/assignments/preview/route.ts");
  const avail = read("src/app/api/availability/route.ts");
  const page = read("src/app/manage/assignments/page.tsx");
  const engine = read("src/lib/autoAssignEngine.ts");
  const excelPreview = read("src/app/api/daily-ops-duties/preview/route.ts");
  const excelApply = read("src/app/api/daily-ops-duties/apply/route.ts");
  const sheetPreview = read("src/app/api/daily-ops-duties/sheet-preview/route.ts");
  const sheetApply = read("src/app/api/daily-ops-duties/sheet-apply/route.ts");
  assert(!/opsDutySheetSync/.test(persist), "persist에 ops duty sheet sync 없음");
  assert(!/opsDutySheetSync/.test(pipeline), "pipeline에 ops duty sheet sync 없음");
  assert(!/opsDutySheetSync/.test(quick), "quick-mutation에 ops duty sheet sync 없음");
  assert(!/opsDutySheetSync/.test(reflow), "reflow에 ops duty sheet sync 없음");
  assert(!/opsDutySheetSync/.test(draft), "draft autosave에 ops duty sheet sync 없음");
  assert(!/opsDutySheetSync/.test(service), "availabilityService에 Google ops duty fetch 없음");
  assert(!/opsDutySheetSync/.test(preview), "auto-assign preview에 sheet sync 없음");
  assert(!/opsDutySheetSync/.test(engine), "autoAssignEngine 미변경");
  assert(
    /fetchPublishedOpsDutySheets/.test(sheetPreview) &&
      /fetchPublishedOpsDutySheets/.test(sheetApply),
    "기존 운영배치 수동 preview/apply 유지"
  );
  assert(
    (page.match(/form\.append\("syncOpsDutySheet", "1"\)/g) || []).length === 1,
    "가용 캐디 불러오기만 Spreadsheet 자동동기화 요청"
  );
  assert(
    /syncOpsDutySheetOnAvailabilityLoad/.test(avail) &&
      /syncOpsDutySheet/.test(avail),
    "availability POST만 sync 옵션"
  );
  assert(
    /export async function GET/.test(avail) &&
      !/syncOpsDutySheetOnAvailabilityLoad/.test(
        avail.split("export async function GET")[1]?.split("export async function POST")[0] ||
          ""
      ),
    "availability GET은 sheet sync 없음"
  );
  assert(
    /syncOpsDutySheet/.test(page) &&
      /운영배치 불러오기/.test(page) &&
      /당번·마샬·조장 Excel/.test(page) &&
      /운영배치 확인 필요/.test(page),
    "버튼 자동동기화 + 수동 불러오기/Excel 유지"
  );
  assert(
    /parseDutyMarshalLeaderWorkbook/.test(excelPreview) &&
      /parseDutyMarshalLeaderWorkbook/.test(excelApply),
    "기존 Excel preview/apply 유지"
  );
}

async function localDb() {
  const url = process.env.DATABASE_URL || "";
  if (!isLocalDatabaseUrl(url)) {
    console.log("\n(skip local autosync DB — DATABASE_URL is not caddy_local)");
    return;
  }
  const { prisma } = await import("../src/lib/prisma");
  const DATE = "2099-10-07";
  const all = await prisma.caddy.findMany({
    where: { employmentStatus: "ACTIVE" },
    select: { id: true, name: true, employmentStatus: true },
    orderBy: { id: "asc" },
  });
  const seen = new Set<string>();
  const active: typeof all = [];
  for (const row of all) {
    if (seen.has(row.name)) continue;
    seen.add(row.name);
    active.push(row);
    if (active.length === 8) break;
  }
  if (active.length < 8) {
    assert(false, "local unique ACTIVE 캐디 8명 필요");
    return;
  }

  const goodNames = namesFromCaddies(active);
  const goodSheets = buildOpsDutySheetTestSheets([
    {
      name: "2099테스트",
      startDate: DATE,
      week1Dates: week(DATE),
      week2Dates: week(addDays(DATE, 7)),
      week1Names: [goodNames, {}, {}, {}, {}, {}, {}],
      week2Names: [],
    },
  ]);
  const previous = await listDailyOpsDuties(DATE);

  const restore = async () => {
    setPublishedOpsDutySheetLoaderForTests(null);
    invalidateOpsDutySheetCache();
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
  };

  try {
    section("정상 8명 → 자동 apply → availability에서 8명 제외");
    invalidateOpsDutySheetCache();
    setPublishedOpsDutySheetLoaderForTests(async () => goodSheets);
    const first = await syncOpsDutySheetOnAvailabilityLoad({ date: DATE });
    assert(first.status === "synced" && first.savedCount === 8, "첫 동기화 8명 저장");
    const listed = await listDailyOpsDuties(DATE);
    assert(listed.length === 8, "DailyOpsDuty 8건");
    const avail = await loadAvailabilityForDate(DATE, {
      includeOffSheet: false,
    });
    const blocked = new Set(avail.opsDutyCaddyIds);
    assert(
      active.every((c) => blocked.has(c.id)),
      "가용에서 8명 제외"
    );
    assert(
      (avail.dailySummary.dutyAdditionalExcluded ?? 0) +
        avail.dailySummary.duplicateExcluded >=
        1,
      "당번 제외가 가용 요약에 반영"
    );

    section("동일 데이터 재실행 → 동일 결과");
    const second = await syncOpsDutySheetOnAvailabilityLoad({ date: DATE });
    assert(second.status === "synced" && second.savedCount === 8, "재실행도 synced");
    const listed2 = await listDailyOpsDuties(DATE);
    assert(
      listed2
        .map((r) => `${r.roleKey}:${r.caddyId}`)
        .sort()
        .join("|") ===
        listed
          .map((r) => `${r.roleKey}:${r.caddyId}`)
          .sort()
          .join("|"),
      "재실행 DailyOpsDuty 동일"
    );

    section("미매칭 1명 → 자동 apply 안 함, 기존 유지");
    const badNames = { ...goodNames, 당번_조출_1: "없는사람XYZ123" };
    setPublishedOpsDutySheetLoaderForTests(async () =>
      buildOpsDutySheetTestSheets([
        {
          name: "2099테스트",
          startDate: DATE,
          week1Dates: week(DATE),
          week2Dates: week(addDays(DATE, 7)),
          week1Names: [badNames, {}, {}, {}, {}, {}, {}],
          week2Names: [],
        },
      ])
    );
    invalidateOpsDutySheetCache();
    const reviewed = await syncOpsDutySheetOnAvailabilityLoad({ date: DATE });
    assert(reviewed.status === "review", "미매칭은 review");
    assert(reviewed.message === "운영배치 확인 필요", "확인 필요 메시지");
    const afterReview = await listDailyOpsDuties(DATE);
    assert(
      afterReview.map((r) => r.caddyId).sort().join(",") ===
        listed.map((r) => r.caddyId).sort().join(","),
      "미매칭 시 기존 DailyOpsDuty 유지"
    );

    section("날짜 없음 → 자동 apply 안 함, 기존 유지");
    setPublishedOpsDutySheetLoaderForTests(async () =>
      buildOpsDutySheetTestSheets([
        {
          name: "2099테스트",
          startDate: addDays(DATE, 1),
          week1Dates: week(addDays(DATE, 1)),
          week2Dates: week(addDays(DATE, 8)),
          week1Names: [goodNames, {}, {}, {}, {}, {}, {}],
          week2Names: [],
        },
      ])
    );
    invalidateOpsDutySheetCache();
    const missingDate = await syncOpsDutySheetOnAvailabilityLoad({ date: DATE });
    assert(missingDate.status === "review", "날짜 없음은 review");
    assert(
      (await listDailyOpsDuties(DATE)).length === 8,
      "날짜 없어도 기존 duty 유지"
    );

    section("중복 날짜 → 자동 apply 안 함");
    setPublishedOpsDutySheetLoaderForTests(async () =>
      buildOpsDutySheetTestSheets([
        {
          name: "탭A",
          startDate: DATE,
          week1Dates: week(DATE),
          week2Dates: week(addDays(DATE, 7)),
          week1Names: [goodNames, {}, {}, {}, {}, {}, {}],
          week2Names: [],
        },
        {
          name: "탭B",
          startDate: DATE,
          week1Dates: week(DATE),
          week2Dates: week(addDays(DATE, 7)),
          week1Names: [goodNames, {}, {}, {}, {}, {}, {}],
          week2Names: [],
        },
      ])
    );
    invalidateOpsDutySheetCache();
    const dup = await syncOpsDutySheetOnAvailabilityLoad({ date: DATE });
    assert(dup.status === "review", "중복 날짜는 review");
    const afterDup = await listDailyOpsDuties(DATE);
    assert(afterDup.length === 8, "중복 날짜여도 기존 8건 유지");

    section("Google fetch 실패 + 기존 DailyOpsDuty → 기존 duty로 availability");
    setPublishedOpsDutySheetLoaderForTests(async () => {
      throw new OpsDutySheetError(
        "운영배치 Google Sheet를 읽지 못했습니다. (HTTP 502)",
        "ops_duty_sheet_fetch_failed",
        502
      );
    });
    invalidateOpsDutySheetCache();
    const failed = await syncOpsDutySheetOnAvailabilityLoad({ date: DATE });
    assert(failed.status === "fetch_failed", "fetch 실패 상태");
    const afterFail = await listDailyOpsDuties(DATE);
    assert(afterFail.length === 8, "fetch 실패 시 기존 duty 유지");
    const availFail = await loadAvailabilityForDate(DATE, {
      includeOffSheet: false,
    });
    assert(
      active.every((c) => availFail.opsDutyCaddyIds.includes(c.id)),
      "기존 duty로 가용 제외 계산"
    );
  } finally {
    await restore();
  }
}

localDb()
  .then(() => {
    console.log(`\nDONE: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
