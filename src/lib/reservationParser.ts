/**
 * 예약표 Excel 파싱 엔진 (자동배치 2단계)
 * - 순수 함수 중심: DB 쓰기 없음
 * - 베르힐 / 스카이 / 오션 / 레이크 예약 행 → 표준 구조
 */

export const COURSE_CODES = ["VERTHILL", "SKY", "OCEAN", "LAKE"] as const;
export type CourseCode = (typeof COURSE_CODES)[number];

export const COURSE_LABELS: Record<CourseCode, string> = {
  VERTHILL: "베르힐",
  SKY: "스카이",
  OCEAN: "오션",
  LAKE: "레이크",
};

export const SHIFT_PARTS = ["1부", "2부", "3부"] as const;
export type ShiftPart = (typeof SHIFT_PARTS)[number];

export type ParsedReservation = {
  date: string;
  course: CourseCode;
  courseLabel: string;
  shift: ShiftPart;
  teeTime: string;
  teamName: string | null;
  hole: number | null;
  startingHole: number | null;
  sourceSheet: string;
  rawRowIndex: number;
  rawData: Record<string, string>;
  needsReview: boolean;
  reviewReasons: string[];
  isDuplicate: boolean;
  duplicateKey: string | null;
};

export type ReservationParseSummary = {
  byDate: Array<{
    date: string;
    totalTeams: number;
    byCourse: Array<{
      course: CourseCode;
      courseLabel: string;
      totalTeams: number;
      byShift: Record<ShiftPart, number>;
    }>;
    byShift: Record<ShiftPart, number>;
  }>;
  totals: {
    teams: number;
    needsReview: number;
    duplicates: number;
    sheets: number;
  };
};

export type ReservationParseResult = {
  reservations: ParsedReservation[];
  needsReview: ParsedReservation[];
  duplicates: ParsedReservation[];
  summary: ReservationParseSummary;
  warnings: string[];
};

type HeaderKind =
  | "date"
  | "teeTime"
  | "teamName"
  | "course"
  | "hole"
  | "startingHole"
  | "shift";

type ColumnMap = Partial<Record<HeaderKind, number>>;

const COURSE_ALIASES: Array<{ code: CourseCode; patterns: RegExp[] }> = [
  {
    code: "VERTHILL",
    patterns: [/베르\s*힐/, /verthill/i, /vert\s*hill/i, /본관/],
  },
  {
    code: "SKY",
    patterns: [/스카이/, /\bsky\b/i],
  },
  {
    code: "OCEAN",
    patterns: [/오션/, /\bocean\b/i],
  },
  {
    code: "LAKE",
    patterns: [/레이크/, /\blake\b/i, /레이크코스/],
  },
];

const HEADER_ALIASES: Record<HeaderKind, string[]> = {
  date: ["날짜", "일자", "예약일", "경기일", "date", "ymd"],
  teeTime: [
    "티타임",
    "티업",
    "시간",
    "출발시간",
    "티업시간",
    "tee",
    "teetime",
    "tee time",
    "time",
  ],
  teamName: [
    "팀명",
    "예약자",
    "예약명",
    "단체명",
    "고객명",
    "성명",
    "이름",
    "팀",
    "team",
    "name",
    "guest",
  ],
  course: ["코스", "코스명", "course", "코스구분"],
  hole: ["홀", "홀수", "hole", "holes"],
  startingHole: ["출발홀", "시작홀", "스타트홀", "startinghole", "start hole", "start"],
  shift: ["부", "타임대", "부제", "교대", "shift", "part"],
};

function compact(text: string): string {
  return text.replace(/\s+/g, "").toLowerCase();
}

export function cellText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  return String(value).replace(/\s+/g, " ").trim();
}

export function normalizeCourse(raw: string | null | undefined): CourseCode | null {
  if (!raw) return null;
  const text = String(raw).trim();
  if (!text) return null;
  for (const entry of COURSE_ALIASES) {
    if (entry.patterns.some((re) => re.test(text))) return entry.code;
  }
  return null;
}

export function normalizeShift(raw: string | null | undefined): ShiftPart | null {
  if (!raw) return null;
  const c = compact(String(raw));
  if (!c) return null;
  if (/(^|[^0-9])1부/.test(c) || c === "1" || c === "one" || c === "part1") return "1부";
  if (/(^|[^0-9])2부/.test(c) || c === "2" || c === "two" || c === "part2") return "2부";
  if (/(^|[^0-9])3부/.test(c) || c === "3" || c === "three" || c === "part3") return "3부";
  if (c.includes("1부")) return "1부";
  if (c.includes("2부")) return "2부";
  if (c.includes("3부")) return "3부";
  return null;
}

/** Excel serial date → YYYY-MM-DD (local-ish, UTC-based serial) */
export function excelSerialToYmd(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 20000 || serial > 80000) return null;
  // Excel epoch 1899-12-30
  const utc = Date.UTC(1899, 11, 30) + Math.round(serial) * 86400000;
  const d = new Date(utc);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function parseDateValue(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const d = String(value.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    // pure time serial (< 1) is not a date
    if (value > 0 && value < 1) return null;
    const fromSerial = excelSerialToYmd(value);
    if (fromSerial) return fromSerial;
  }

  const text = cellText(value);
  if (!text) return null;

  // 2026년 8월 10일
  let m = text.match(/(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일?/);
  if (m) {
    return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  }

  // YYYY-MM-DD / YYYY.MM.DD / YYYY/MM/DD
  m = text.match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})/);
  if (m) {
    return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  }
  // YY-MM-DD
  m = text.match(/^(\d{2})[./-](\d{1,2})[./-](\d{1,2})$/);
  if (m) {
    const yy = Number(m[1]);
    const yyyy = yy >= 70 ? 1900 + yy : 2000 + yy;
    return `${yyyy}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  }
  // M/D/YYYY
  m = text.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (m) {
    return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  }
  // 숫자만 (엑셀 serial 문자열)
  if (/^\d+(\.\d+)?$/.test(text)) {
    return excelSerialToYmd(Number(text));
  }
  return null;
}

/**
 * 티타임 → HH:mm
 * 지원: 6:30, 06:30, 0630, 6시30분, Excel time serial, Date
 */
export function parseTeeTime(value: unknown): string | null {
  if (value == null || value === "") return null;

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const hh = String(value.getHours()).padStart(2, "0");
    const mm = String(value.getMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    // Excel time fraction or datetime serial with fraction
    let fraction = value;
    if (value >= 1) fraction = value % 1;
    if (fraction < 0) return null;
    const totalMinutes = Math.round(fraction * 24 * 60);
    if (totalMinutes < 0 || totalMinutes >= 24 * 60) return null;
    const hh = String(Math.floor(totalMinutes / 60) % 24).padStart(2, "0");
    const mm = String(totalMinutes % 60).padStart(2, "0");
    return `${hh}:${mm}`;
  }

  const text = cellText(value);
  if (!text) return null;

  let m = text.match(/^(\d{1,2})\s*[:：]\s*(\d{1,2})(?:\s*[:：]\s*\d{1,2})?$/);
  if (m) {
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h >= 0 && h <= 23 && min >= 0 && min <= 59) {
      return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
    }
    return null;
  }

  m = text.match(/^(\d{1,2})\s*시\s*(\d{1,2})\s*분?$/);
  if (m) {
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h >= 0 && h <= 23 && min >= 0 && min <= 59) {
      return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
    }
    return null;
  }

  // 0630 / 630
  m = text.match(/^(\d{3,4})$/);
  if (m) {
    const digits = m[1].padStart(4, "0");
    const h = Number(digits.slice(0, 2));
    const min = Number(digits.slice(2));
    if (h >= 0 && h <= 23 && min >= 0 && min <= 59) {
      return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
    }
  }

  // ISO datetime fragment
  m = text.match(/T(\d{2}):(\d{2})/);
  if (m) return `${m[1]}:${m[2]}`;

  return null;
}

/** 티타임으로 부 추정: 1부 <12:00, 2부 12:00–15:59, 3부 ≥16:00 */
export function inferShiftFromTeeTime(teeTime: string): ShiftPart {
  const [hStr, mStr] = teeTime.split(":");
  const minutes = Number(hStr) * 60 + Number(mStr);
  if (minutes < 12 * 60) return "1부";
  if (minutes < 16 * 60) return "2부";
  return "3부";
}

export function parseHoleValue(value: unknown): number | null {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    const n = Math.trunc(value);
    return n > 0 ? n : null;
  }
  const text = cellText(value);
  const m = text.match(/(\d{1,2})/);
  if (!m) return null;
  const n = Number(m[1]);
  return n > 0 ? n : null;
}

function normalizeHeaderToken(raw: string): string {
  return compact(raw).replace(/[()[\]{}]/g, "");
}

export function matchHeaderKind(cell: string): HeaderKind | null {
  const token = normalizeHeaderToken(cell);
  if (!token) return null;
  for (const [kind, aliases] of Object.entries(HEADER_ALIASES) as Array<
    [HeaderKind, string[]]
  >) {
    for (const alias of aliases) {
      const a = normalizeHeaderToken(alias);
      if (token === a || token.includes(a)) {
        // "출발홀" should not match generic "홀" as hole when startingHole exists —
        // prefer longer / more specific: handled by checking startingHole aliases first below
        if (kind === "hole" && /출발|시작|스타트|starting|start/.test(token)) {
          continue;
        }
        if (kind === "teeTime" && token === "일자") continue;
        return kind;
      }
    }
  }
  // explicit starting hole after hole skip
  if (/출발홀|시작홀|스타트홀|startinghole|starthole/.test(token)) {
    return "startingHole";
  }
  return null;
}

export function detectHeaderRow(
  matrix: string[][],
  maxScanRows = 15
): { headerRow: number; columns: ColumnMap } | null {
  const limit = Math.min(maxScanRows, matrix.length);
  let best: { headerRow: number; columns: ColumnMap; score: number } | null = null;

  for (let r = 0; r < limit; r++) {
    const row = matrix[r] || [];
    const columns: ColumnMap = {};
    for (let c = 0; c < row.length; c++) {
      const kind = matchHeaderKind(row[c] || "");
      if (!kind) continue;
      if (columns[kind] == null) columns[kind] = c;
    }
    const score =
      (columns.teeTime != null ? 3 : 0) +
      (columns.teamName != null ? 2 : 0) +
      (columns.date != null ? 1 : 0) +
      (columns.course != null ? 1 : 0) +
      (columns.shift != null ? 1 : 0) +
      (columns.hole != null || columns.startingHole != null ? 1 : 0);

    if (columns.teeTime == null) continue;
    if (!best || score > best.score) {
      best = { headerRow: r, columns, score };
    }
  }

  return best ? { headerRow: best.headerRow, columns: best.columns } : null;
}

function extractDateFromText(text: string): string | null {
  if (!text) return null;
  // 2026년 8월 10일
  let m = text.match(/(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일?/);
  if (m) {
    return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  }
  return parseDateValue(text);
}

export function inferContextFromSheetName(sheetName: string): {
  course: CourseCode | null;
  shift: ShiftPart | null;
  date: string | null;
} {
  return {
    course: normalizeCourse(sheetName),
    shift: normalizeShift(sheetName),
    date: extractDateFromText(sheetName),
  };
}

function emptyShiftCounts(): Record<ShiftPart, number> {
  return { "1부": 0, "2부": 0, "3부": 0 };
}

function isBlankRow(row: unknown[]): boolean {
  return row.every((v) => cellText(v) === "");
}

function buildRawData(
  headerRow: string[],
  values: unknown[],
  columns: ColumnMap
): Record<string, string> {
  const raw: Record<string, string> = {};
  const used = new Set<number>();
  for (const [kind, idx] of Object.entries(columns)) {
    if (idx == null) continue;
    const label = headerRow[idx] || kind;
    raw[label] = cellText(values[idx]);
    used.add(idx);
  }
  // preserve other non-empty cells
  for (let c = 0; c < values.length; c++) {
    if (used.has(c)) continue;
    const t = cellText(values[c]);
    if (!t) continue;
    const key = headerRow[c] || `col_${c + 1}`;
    if (raw[key] == null) raw[key] = t;
  }
  return raw;
}

export function parseReservationMatrix(
  matrix: unknown[][],
  options: {
    sourceSheet: string;
    defaultDate?: string | null;
    defaultCourse?: CourseCode | null;
    defaultShift?: ShiftPart | null;
  }
): ParsedReservation[] {
  const stringMatrix = matrix.map((row) => row.map((c) => cellText(c)));
  const detected = detectHeaderRow(stringMatrix);
  if (!detected) return [];

  const { headerRow, columns } = detected;
  const headerLabels = stringMatrix[headerRow] || [];
  const sheetCtx = inferContextFromSheetName(options.sourceSheet);
  const fallbackDate = options.defaultDate || sheetCtx.date;
  const fallbackCourse = options.defaultCourse || sheetCtx.course;
  const fallbackShift = options.defaultShift || sheetCtx.shift;

  const out: ParsedReservation[] = [];

  for (let r = headerRow + 1; r < matrix.length; r++) {
    const values = matrix[r] || [];
    if (isBlankRow(values)) continue;

    // skip repeated header-like rows
    const maybeHeader = values
      .map((v) => matchHeaderKind(cellText(v)))
      .filter(Boolean);
    if (maybeHeader.length >= 2) continue;

    const rawData = buildRawData(headerLabels, values, columns);
    const reviewReasons: string[] = [];

    const teeRaw =
      columns.teeTime != null ? values[columns.teeTime] : undefined;
    const teeTime = parseTeeTime(teeRaw);
    if (!teeTime) {
      reviewReasons.push("잘못된 시간 형식");
    }

    const dateRaw = columns.date != null ? values[columns.date] : undefined;
    let date = parseDateValue(dateRaw) || fallbackDate || null;
    if (!date) reviewReasons.push("날짜 없음");

    const courseRaw =
      columns.course != null ? cellText(values[columns.course]) : "";
    let course = normalizeCourse(courseRaw) || fallbackCourse;
    if (!course) reviewReasons.push("코스 판별 실패");

    const shiftRaw =
      columns.shift != null ? cellText(values[columns.shift]) : "";
    let shift = normalizeShift(shiftRaw) || fallbackShift;
    if (!shift && teeTime) shift = inferShiftFromTeeTime(teeTime);
    if (!shift) reviewReasons.push("부 판별 실패");

    const teamRaw =
      columns.teamName != null ? cellText(values[columns.teamName]) : "";
    const teamName = teamRaw || null;
    if (!teamName) reviewReasons.push("예약자/팀명 없음");

    const hole =
      columns.hole != null ? parseHoleValue(values[columns.hole]) : null;
    const startingHole =
      columns.startingHole != null
        ? parseHoleValue(values[columns.startingHole])
        : null;

    // If almost everything empty except noise, skip
    if (!teeTime && !teamName && !courseRaw && !dateRaw) continue;

    const needsReview = reviewReasons.length > 0;
    const courseCode = course || "VERTHILL";
    const row: ParsedReservation = {
      date: date || "",
      course: courseCode,
      courseLabel: COURSE_LABELS[courseCode],
      shift: shift || "1부",
      teeTime: teeTime || cellText(teeRaw),
      teamName,
      hole,
      startingHole,
      sourceSheet: options.sourceSheet,
      rawRowIndex: r + 1, // 1-based spreadsheet row
      rawData,
      needsReview,
      reviewReasons,
      isDuplicate: false,
      duplicateKey: null,
    };
    out.push(row);
  }

  return out;
}

export function markDuplicates(rows: ParsedReservation[]): ParsedReservation[] {
  const keyCount = new Map<string, number>();
  for (const row of rows) {
    if (!row.date || !row.teeTime || row.needsReview) continue;
    // duplicate = same date + course + teeTime (+ optional startingHole)
    const key = [
      row.date,
      row.course,
      row.teeTime,
      row.startingHole ?? "",
    ].join("|");
    keyCount.set(key, (keyCount.get(key) || 0) + 1);
  }

  return rows.map((row) => {
    if (!row.date || !row.teeTime || row.needsReview) return row;
    const key = [
      row.date,
      row.course,
      row.teeTime,
      row.startingHole ?? "",
    ].join("|");
    const count = keyCount.get(key) || 0;
    if (count <= 1) return row;
    const reasons = row.reviewReasons.includes("중복 티타임")
      ? row.reviewReasons
      : [...row.reviewReasons, "중복 티타임"];
    return {
      ...row,
      isDuplicate: true,
      duplicateKey: key,
      needsReview: true,
      reviewReasons: reasons,
    };
  });
}

export function buildReservationSummary(
  rows: ParsedReservation[],
  sheetCount: number
): ReservationParseSummary {
  const valid = rows.filter((r) => !r.needsReview && r.date && r.teeTime);
  const dates = [...new Set(valid.map((r) => r.date))].sort();

  const byDate = dates.map((date) => {
    const dayRows = valid.filter((r) => r.date === date);
    const byShift = emptyShiftCounts();
    for (const r of dayRows) byShift[r.shift] += 1;

    const courses = COURSE_CODES.filter((c) =>
      dayRows.some((r) => r.course === c)
    );
    const byCourse = courses.map((course) => {
      const courseRows = dayRows.filter((r) => r.course === course);
      const shiftCounts = emptyShiftCounts();
      for (const r of courseRows) shiftCounts[r.shift] += 1;
      return {
        course,
        courseLabel: COURSE_LABELS[course],
        totalTeams: courseRows.length,
        byShift: shiftCounts,
      };
    });

    return {
      date,
      totalTeams: dayRows.length,
      byCourse,
      byShift,
    };
  });

  return {
    byDate,
    totals: {
      teams: valid.length,
      needsReview: rows.filter((r) => r.needsReview).length,
      duplicates: rows.filter((r) => r.isDuplicate).length,
      sheets: sheetCount,
    },
  };
}

export function finalizeReservationParse(
  rows: ParsedReservation[],
  sheetCount: number,
  warnings: string[] = []
): ReservationParseResult {
  const withDupes = markDuplicates(rows);
  // stable sort: date, course order, shift, teeTime, sheet, row
  const courseRank = Object.fromEntries(
    COURSE_CODES.map((c, i) => [c, i])
  ) as Record<CourseCode, number>;
  const shiftRank = Object.fromEntries(
    SHIFT_PARTS.map((s, i) => [s, i])
  ) as Record<ShiftPart, number>;

  const sorted = [...withDupes].sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    if (a.course !== b.course) return courseRank[a.course] - courseRank[b.course];
    if (a.shift !== b.shift) return shiftRank[a.shift] - shiftRank[b.shift];
    if (a.teeTime !== b.teeTime) return a.teeTime.localeCompare(b.teeTime);
    if (a.sourceSheet !== b.sourceSheet) {
      return a.sourceSheet.localeCompare(b.sourceSheet);
    }
    return a.rawRowIndex - b.rawRowIndex;
  });

  return {
    reservations: sorted,
    needsReview: sorted.filter((r) => r.needsReview),
    duplicates: sorted.filter((r) => r.isDuplicate),
    summary: buildReservationSummary(sorted, sheetCount),
    warnings,
  };
}

/** 행렬 배열(시트별)을 받아 표준 결과로 변환 — 단위 테스트용 진입점 */
export function parseReservationSheets(
  sheets: Array<{ name: string; matrix: unknown[][] }>,
  options?: { defaultDate?: string | null }
): ReservationParseResult {
  const warnings: string[] = [];
  const all: ParsedReservation[] = [];

  for (const sheet of sheets) {
    const rows = parseReservationMatrix(sheet.matrix, {
      sourceSheet: sheet.name,
      defaultDate: options?.defaultDate ?? null,
    });
    if (rows.length === 0) {
      warnings.push(`시트 "${sheet.name}": 헤더/예약 행을 찾지 못함`);
      continue;
    }
    all.push(...rows);
  }

  return finalizeReservationParse(all, sheets.length, warnings);
}

