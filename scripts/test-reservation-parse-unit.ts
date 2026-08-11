/**
 * 예약표 파싱 단위 테스트 (DB 없음)
 * 실행: npx tsx scripts/test-reservation-parse-unit.ts
 *
 * shift = 시트 공통 티타임 밴드(큰 시간 gap으로 3분리).
 * 명시적 1부/2부/3부 셀·절대시각 threshold·bare 1/2/3 미사용.
 */

import {
  buildRowShiftMap,
  detectCourseBlocks,
  detectExplicitShiftLabel,
  detectHeaderRow,
  findTeeBandBreakIndices,
  matchHeaderKind,
  normalizeCourse,
  normalizeShift,
  normalizeShiftColumn,
  parseDateValue,
  parseReservationSheets,
  parseTeeTime,
  SHIFT_NOT_DETECTED,
  teeTimeToMinutes,
  type ParsedReservation,
} from "../src/lib/reservationParser";
import {
  buildTestReservationXlsxBuffer,
  parseReservationWorkbook,
} from "../src/lib/reservationImportXlsx";

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

function okRows(rows: ParsedReservation[]) {
  return rows.filter((r) => !r.needsReview);
}

function empty11() {
  return Array(11).fill("");
}

function blockHeader() {
  return [
    "코스명",
    "시간",
    "예약자",
    "내장객1",
    "내장객2",
    "내장객3",
    "내장객4",
    "x",
    "y",
    "출발홀",
    "캐디명",
  ];
}

function fourCourseHeader() {
  return [
    ...blockHeader(),
    ...blockHeader(),
    ...blockHeader(),
    ...blockHeader(),
  ];
}

function data11(
  course: string,
  time: string,
  team: string,
  opts?: { hole?: string | number; caddy?: string }
) {
  return [
    course,
    time,
    team,
    "",
    "",
    "",
    "",
    "",
    "",
    opts?.hole ?? "",
    opts?.caddy ?? "",
  ];
}

const LABELS = ["베르힐", "스카이", "오션", "레이크"] as const;

/**
 * 가로 4코스 + 3개 티타임 밴드(중간 ~3시간 gap).
 * perBandTotals: [1부, 2부, 3부] 팀 수 — 코스별로 분배.
 */
function buildBandedFourCourseMatrix(opts: {
  date: string;
  bandStarts: [string, string, string];
  perBandTotals: [number, number, number];
  /** 코스별 2부 시작 오프셋(분), 기본 0 */
  course2OffsetsMin?: number[];
}): unknown[][] {
  const { date, bandStarts, perBandTotals } = opts;
  const offsets = opts.course2OffsetsMin ?? [0, 0, 0, 0];
  const matrix: unknown[][] = [
    ["경기진행등록", "", "", date],
    fourCourseHeader(),
  ];

  // 슬롯 수: 총합을 4코스에 나누되 행은 max ceil
  const buildBand = (start: string, total: number, bandIdx: number) => {
    const slots = Math.ceil(total / 4);
    // 코스별 목표 건수 (앞 코스에 나머지)
    const base = Math.floor(total / 4);
    const rem = total % 4;
    const nPer = LABELS.map((_, i) => base + (i < rem ? 1 : 0));
    const startMin =
      teeTimeToMinutes(start)! + (bandIdx === 1 ? 0 : 0);
    for (let i = 0; i < slots; i++) {
      const row: unknown[] = [];
      for (let b = 0; b < 4; b++) {
        if (i < nPer[b]) {
          const off = bandIdx === 1 ? offsets[b] : 0;
          const mins = startMin + off + i * 7;
          const t = `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(
            mins % 60
          ).padStart(2, "0")}`;
          const hole = i % 2 === 0 ? 1 : 10;
          row.push(
            ...data11(LABELS[b], t, `${LABELS[b]}-${t}`, {
              hole,
              caddy: `캐디${LABELS[b]}${i}`,
            })
          );
        } else {
          row.push(...empty11());
        }
      }
      matrix.push(row);
    }
  };

  buildBand(bandStarts[0], perBandTotals[0], 0);
  // ~3시간 gap은 band start 시각 차이로 표현 (행은 연속, 시각만 점프)
  buildBand(bandStarts[1], perBandTotals[1], 1);
  buildBand(bandStarts[2], perBandTotals[2], 2);
  return matrix;
}

function shiftCounts(result: ReturnType<typeof parseReservationSheets>) {
  const ok = okRows(result.reservations);
  const c = { "1부": 0, "2부": 0, "3부": 0, null: 0 };
  for (const r of ok) {
    if (r.shift) c[r.shift] += 1;
  }
  for (const r of result.reservations) {
    if (r.shift == null) c.null += 1;
  }
  return { ok: ok.length, ...c, review: result.needsReview.length };
}

section("helpers: explicit label / bare digit 금지");
assert(normalizeCourse("베르힐") === "VERTHILL", "베르힐");
assert(detectExplicitShiftLabel("1부") === "1부", "explicit 1부");
assert(detectExplicitShiftLabel("1") === null, "bare 1 rejected");
assert(normalizeShift("3") === null, "normalizeShift bare 3 null");
assert(normalizeShiftColumn("2부") === "2부", "column 2부");
assert(teeTimeToMinutes("11:20") === 11 * 60 + 20, "tee minutes");
assert(
  findTeeBandBreakIndices([7, 7, 7, 187, 7, 7, 190, 7]).length === 2,
  "two large gaps → 2 breaks"
);
assert(
  findTeeBandBreakIndices([7, 7, 7, 7]).length === 0,
  "no large gap → no break"
);

section("parseTeeTime / header");
assert(parseTeeTime("6:30") === "06:30", "6:30");
assert(matchHeaderKind("출발홀") === "startingHole", "출발홀");
assert(matchHeaderKind("캐디명") !== "teamName", "캐디명 ≠ teamName");
assert(
  detectHeaderRow([
    ["예약표"],
    [],
    ["날짜", "시간", "코스", "팀명", "출발홀"],
  ])?.headerRow === 2,
  "header row 2"
);

section("티타임 밴드: 11:xx는 2부, 17:xx는 3부 (절대시각 threshold 아님)");
{
  const matrix = buildBandedFourCourseMatrix({
    date: "2026-08-10",
    bandStarts: ["05:53", "11:20", "16:40"],
    perBandTotals: [8, 8, 8],
  });
  const result = parseReservationSheets(
    [{ name: "경기진행등록", matrix }],
    { defaultDate: "2026-08-10" }
  );
  const ok = okRows(result.reservations);
  assert(ok.length === 24, "24 teams");
  assert(ok.every((r) => r.shift != null), "all have shift");
  assert(
    ok.filter((r) => r.teeTime >= "11:20" && r.teeTime < "14:00").every(
      (r) => r.shift === "2부"
    ),
    "11:xx band is 2부"
  );
  assert(
    ok.filter((r) => r.teeTime >= "16:40").every((r) => r.shift === "3부"),
    "16:40+ is 3부"
  );
  assert(
    ok.filter((r) => r.teeTime < "09:00").every((r) => r.shift === "1부"),
    "morning is 1부"
  );
  assert(
    ok.some((r) => r.startingHole === 1 && r.shift === "2부"),
    "출발홀=1 does not force 1부"
  );
}

section("밴드 미분리 → SHIFT_NOT_DETECTED");
{
  const result = parseReservationSheets([
    {
      name: "스카이",
      matrix: [
        ["날짜", "시간", "팀명"],
        ["2026-08-11", "07:00", "A"],
        ["2026-08-11", "07:07", "B"],
        ["2026-08-11", "07:14", "C"],
      ],
    },
  ]);
  assert(
    result.reservations.every((r) => r.shift === null),
    "shift null without 3 bands"
  );
  assert(
    result.reservations.every((r) =>
      r.reviewReasons.includes(SHIFT_NOT_DETECTED)
    ),
    "SHIFT_NOT_DETECTED"
  );
  assert(result.summary.totals.teams === 0, "not counted");
}

section("빈 코스 블록이 있어도 행 밴드 유지");
{
  const DATE = "2026-08-12";
  const matrix: unknown[][] = [
    ["경기진행등록", "", "", DATE],
    fourCourseHeader(),
    // 1부
    [
      ...data11("베르힐", "06:00", "V1", { hole: 1 }),
      ...empty11(),
      ...data11("오션", "06:00", "O1", { hole: 10 }),
      ...data11("레이크", "06:00", "L1", { hole: 1, caddy: "과거캐디" }),
    ],
    [
      ...data11("베르힐", "06:07", "V2", { hole: 1 }),
      ...empty11(),
      ...data11("오션", "06:07", "O2", { hole: 1 }),
      ...empty11(),
    ],
    // 2부 (~3h later)
    [
      ...data11("베르힐", "11:20", "V3", { hole: 1 }),
      ...empty11(),
      ...data11("오션", "11:20", "O3", { hole: 1 }),
      ...data11("레이크", "11:27", "L3", { hole: 10 }),
    ],
    [
      ...data11("베르힐", "11:27", "V4", { hole: 1 }),
      ...empty11(),
      ...empty11(),
      ...data11("레이크", "11:34", "L4", { hole: 1 }),
    ],
    // 3부 (밴드 내부 ~7분; 큰 gap은 밴드 사이에만)
    [
      ...data11("베르힐", "16:40", "V5", { hole: 1 }),
      ...empty11(),
      ...empty11(),
      ...data11("레이크", "16:40", "L5", { hole: 1 }),
    ],
    [
      ...data11("베르힐", "16:47", "V6", { hole: 10 }),
      ...empty11(),
      ...empty11(),
      ...data11("레이크", "16:47", "L6", { hole: 1 }),
    ],
    [
      ...data11("베르힐", "16:54", "V7", { hole: 10 }),
      ...empty11(),
      ...empty11(),
      ...empty11(),
    ],
  ];
  const map = buildRowShiftMap(matrix);
  assert(map[2] === "1부", "row band 1부");
  assert(map[4] === "2부", "row band 2부");
  assert(map[6] === "3부", "row band 3부");
  const result = parseReservationSheets([{ name: "경기진행등록", matrix }], {
    defaultDate: DATE,
  });
  const ok = okRows(result.reservations);
  assert(!ok.some((r) => r.course === "SKY"), "SKY closed");
  assert(
    ok.find((r) => r.teeTime === "11:20")?.shift === "2부",
    "11:20 → 2부 via shared band"
  );
  assert(
    ok.find((r) => r.teeTime === "16:54")?.shift === "3부",
    "16:54 → 3부"
  );
  assert(
    ok.find((r) => r.teamName === "L1")?.rawData["캐디명"] === "과거캐디",
    "caddy in rawData only"
  );
}

section("잘못된 시간 / 중복 / 부 컬럼(옵션)");
{
  const bad = parseReservationSheets([
    {
      name: "오션",
      matrix: [
        ["날짜", "티타임", "예약자"],
        ["2026-08-12", "아침", "X"],
        ["2026-08-12", "06:00", "A"],
        ["2026-08-12", "06:07", "B"],
        ["2026-08-12", "11:20", "C"],
        ["2026-08-12", "11:27", "D"],
        ["2026-08-12", "16:40", "E"],
        ["2026-08-12", "16:47", "F"],
      ],
    },
  ]);
  assert(
    bad.needsReview.some((r) => r.reviewReasons.some((x) => x.includes("시간"))),
    "bad time review"
  );

  const col = parseReservationSheets([
    {
      name: "스카이",
      matrix: [
        ["No", "경기일", "티업시간", "단체명", "부", "코스"],
        [1, "2026-08-15", "06:50", "헤더아래", "1부", "스카이"],
        [2, "2026-08-15", "14:00", "오후", "2부", "스카이"],
      ],
    },
  ]);
  assert(col.summary.totals.teams === 2, "explicit 부 column still works");
  assert(col.reservations[0].shift === "1부", "column 1부");
}

section("xlsx roundtrip + 빈 예약자 스킵");
{
  const buf = buildTestReservationXlsxBuffer([
    {
      name: "오션",
      aoa: [
        ["날짜", "티타임", "예약자", "출발홀"],
        ["2026-08-16", "06:00", "A", 1],
        ["2026-08-16", "06:07", "B", 1],
        ["2026-08-16", "11:20", "C", 1],
        ["2026-08-16", "11:27", "D", 1],
        ["2026-08-16", "16:40", "E", 1],
        ["2026-08-16", "16:47", "F", 1],
      ],
    },
  ]);
  const result = parseReservationWorkbook(buf, {
    filename: "예약_2026-08-16.xlsx",
  });
  assert(result.summary.totals.teams === 6, "xlsx 6 with bands");
  assert(
    result.reservations.filter((r) => r.shift === "2부").length === 2,
    "xlsx 2부"
  );

  const vacant = parseReservationSheets([
    {
      name: "베르힐",
      matrix: [
        ["날짜", "티타임", "예약자"],
        ["2026-08-17", "06:00", ""],
        ["2026-08-17", "06:07", "실제"],
        ["2026-08-17", "11:20", "오후"],
        ["2026-08-17", "11:27", "오후2"],
        ["2026-08-17", "16:40", "야간"],
        ["2026-08-17", "16:47", "야간2"],
      ],
    },
  ]);
  assert(
    vacant.reservations.every((r) => r.teamName),
    "empty team skipped"
  );
  assert(vacant.summary.totals.teams === 5, "5 teams");
}

section("회귀: 경기진행등록.xls 205 = 75/63/67 (구 96/42/67 폐기)");
{
  const DATE = "2026-08-20";
  const matrix = buildBandedFourCourseMatrix({
    date: DATE,
    bandStarts: ["05:53", "11:20", "16:40"],
    perBandTotals: [75, 63, 67],
    // 코스별 2부 시작이 약간 다름 (11:20/11:27/11:20/11:34)
    course2OffsetsMin: [0, 7, 0, 14],
  });
  const blocks = detectCourseBlocks(
    matrix.map((r) => r.map((c) => String(c ?? "")))
  );
  assert(blocks.length === 4, "4 blocks");
  const result = parseReservationSheets([{ name: "경기진행등록", matrix }], {
    defaultDate: DATE,
  });
  const sc = shiftCounts(result);
  assert(sc.ok === 205, "total 205");
  assert(sc["1부"] === 75, "1부 75");
  assert(sc["2부"] === 63, "2부 63");
  assert(sc["3부"] === 67, "3부 67");
  assert(result.needsReview.length === 0, "no SHIFT_NOT_DETECTED");
  assert(
    !okRows(result.reservations).some(
      (r) => r.shift === "1부" && r.teeTime >= "11:20"
    ),
    "11:xx not in 1부"
  );
  assert(
    !okRows(result.reservations).some(
      (r) =>
        r.teeTime >= "17:00" && (r.shift === "1부" || r.shift === "2부")
    ),
    "17~18 not in 1/2부"
  );
  const day = result.summary.byDate[0];
  assert(day?.byShift["1부"] === 75, "summary 1부 75");
  assert(day?.byShift["2부"] === 63, "summary 2부 63");
  assert(day?.byShift["3부"] === 67, "summary 3부 67");
}

section("다중 날짜 fixture 건수");
{
  const cases: Array<{
    name: string;
    date: string;
    counts: [number, number, number];
  }> = [
    { name: "5.29.xls", date: "2026-05-29", counts: [84, 84, 76] },
    { name: "6.10.xls", date: "2026-06-10", counts: [84, 84, 76] },
    { name: "6.12.xls", date: "2026-06-12", counts: [84, 83, 76] },
    { name: "05.17.xls", date: "2026-05-17", counts: [84, 68, 72] },
  ];
  for (const c of cases) {
    const matrix = buildBandedFourCourseMatrix({
      date: c.date,
      bandStarts: ["05:53", "11:20", "16:40"],
      perBandTotals: c.counts,
    });
    const result = parseReservationSheets(
      [{ name: "경기진행등록", matrix }],
      { defaultDate: c.date }
    );
    const total = c.counts[0] + c.counts[1] + c.counts[2];
    const sc = shiftCounts(result);
    assert(sc.ok === total, `${c.name} total ${total}`);
    assert(sc["1부"] === c.counts[0], `${c.name} 1부 ${c.counts[0]}`);
    assert(sc["2부"] === c.counts[1], `${c.name} 2부 ${c.counts[1]}`);
    assert(sc["3부"] === c.counts[2], `${c.name} 3부 ${c.counts[2]}`);
    assert(result.needsReview.length === 0, `${c.name} no review`);
  }
}

section("캐디명·출발홀이 밴드를 바꾸지 않음");
{
  const matrix = buildBandedFourCourseMatrix({
    date: "2026-08-23",
    bandStarts: ["06:00", "11:20", "16:40"],
    perBandTotals: [4, 4, 4],
  });
  // 이미 hole=1/10, caddy 채워짐
  const before = buildRowShiftMap(matrix);
  // 캐디명 열을 더 채워도 map 동일
  for (let r = 2; r < matrix.length; r++) {
    for (const base of [10, 21, 32, 43]) {
      if (matrix[r][base - 10]) matrix[r][base] = "추가캐디";
    }
  }
  const after = buildRowShiftMap(matrix);
  assert(
    before.every((s, i) => s === after[i]),
    "caddy fill does not change rowShiftMap"
  );
}

console.log(`\nDONE: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
