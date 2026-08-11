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

/** 부 미검출 시 reviewReasons에 넣는 고정 코드 */
export const SHIFT_NOT_DETECTED = "SHIFT_NOT_DETECTED";

export type ParsedReservation = {
  date: string;
  /** 코스 판별 실패 시 null — VERTHILL 강제 fallback 없음 */
  course: CourseCode | null;
  courseLabel: string;
  /** 명시적 부 구간/컬럼으로만 확정. 미검출 시 null (1부 fallback 없음) */
  shift: ShiftPart | null;
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

/** 한 시트 안 가로 반복 코스 블록 (예: A:K / L:V / W:AG / AH:AR) */
export type CourseBlock = {
  headerRow: number;
  startCol: number;
  endCol: number;
  columns: ColumnMap;
  /** 블록 데이터/상단 제목에서 추론한 기본 코스 */
  defaultCourse: CourseCode | null;
};

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

/**
 * 섹션 헤더·행 전체 검색용: 문자열에 "1부"/"2부"/"3부"가 명시된 경우만.
 * bare "1"|"2"|"3", 출발홀·인원수 숫자는 절대 인정하지 않음.
 */
export function detectExplicitShiftLabel(
  raw: string | null | undefined
): ShiftPart | null {
  if (raw == null) return null;
  const text = String(raw).replace(/\s+/g, " ").trim();
  if (!text) return null;
  const c = compact(text);
  if (!c) return null;
  // 순수 숫자(출발홀 1, 인원 2 등) 금지
  if (/^\d+$/.test(c)) return null;
  // 3 → 2 → 1 순으로 매칭 (겹침 방지)
  if (/(^|[^0-9])3부/.test(c)) return "3부";
  if (/(^|[^0-9])2부/.test(c)) return "2부";
  if (/(^|[^0-9])1부/.test(c)) return "1부";
  return null;
}

/**
 * 전용 부(shift) 컬럼 값 정규화.
 * 섹션 헤더와 동일하게 "부"가 포함된 명시 표기만 허용 (bare 1/2/3 금지).
 */
export function normalizeShiftColumn(
  raw: string | null | undefined
): ShiftPart | null {
  return detectExplicitShiftLabel(raw);
}

/**
 * @deprecated bare "1"/"2"/"3" 허용하던 구버전.
 * 신규 코드는 detectExplicitShiftLabel / normalizeShiftColumn 사용.
 * 호환: 명시적 "N부"만 반환 (bare digit 제거).
 */
export function normalizeShift(raw: string | null | undefined): ShiftPart | null {
  return detectExplicitShiftLabel(raw);
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

/**
 * @deprecated 파싱 경로에서 사용 금지.
 * 현장 2부는 11시대부터, 3부는 17~18시대가 있어 teeTime→부 추정은 구조적으로 틀림.
 * 디버그/구 테스트 호환용으로만 유지.
 */
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

/**
 * 헤더 행에서 가로 반복되는 코스 블록을 모두 탐지.
 * - "시간/티타임" 헤더가 여러 번 나타나면 각각 독립 블록
 * - 단일 테이블(헤더 1세트)도 블록 1개로 처리
 */
export function detectCourseBlocks(
  matrix: string[][],
  maxScanRows = 20
): CourseBlock[] {
  const limit = Math.min(maxScanRows, matrix.length);
  let bestRow = -1;
  let bestScore = -1;
  let bestTeeCols: number[] = [];

  for (let r = 0; r < limit; r++) {
    const row = matrix[r] || [];
    const teeCols: number[] = [];
    let teamCount = 0;
    let courseCount = 0;
    let dateCount = 0;
    let shiftCount = 0;
    let holeCount = 0;
    for (let c = 0; c < row.length; c++) {
      const kind = matchHeaderKind(row[c] || "");
      if (kind === "teeTime") teeCols.push(c);
      else if (kind === "teamName") teamCount += 1;
      else if (kind === "course") courseCount += 1;
      else if (kind === "date") dateCount += 1;
      else if (kind === "shift") shiftCount += 1;
      else if (kind === "hole" || kind === "startingHole") holeCount += 1;
    }
    if (teeCols.length === 0) continue;
    const score =
      teeCols.length * 5 +
      teamCount * 2 +
      courseCount +
      dateCount +
      shiftCount +
      holeCount;
    if (score > bestScore) {
      bestScore = score;
      bestRow = r;
      bestTeeCols = teeCols;
    }
  }

  if (bestRow < 0 || bestTeeCols.length === 0) return [];

  const header = matrix[bestRow] || [];
  const blocks: CourseBlock[] = [];

  for (let i = 0; i < bestTeeCols.length; i++) {
    const teeCol = bestTeeCols[i];
    const prevTee = i > 0 ? bestTeeCols[i - 1] : null;
    const nextTee = bestTeeCols[i + 1];
    const leftBound = prevTee == null ? 0 : prevTee + 1;

    // 시간 열 왼쪽으로 코스/날짜 헤더까지 확장
    let startCol = teeCol;
    for (let c = teeCol - 1; c >= leftBound; c--) {
      const kind = matchHeaderKind(header[c] || "");
      if (
        kind === "course" ||
        kind === "date" ||
        kind === "shift" ||
        kind === "teamName" ||
        kind === "hole" ||
        kind === "startingHole"
      ) {
        startCol = c;
      } else {
        break;
      }
    }
    if (i === 0) {
      // 단일 테이블: 선두 장식열 없이 날짜가 더 앞에 있을 수 있음
      for (let c = startCol - 1; c >= 0; c--) {
        const kind = matchHeaderKind(header[c] || "");
        if (kind) startCol = c;
        else break;
      }
    }

    // 다음 블록의 코스열(보통 nextTee-1)은 제외
    let endCol: number;
    if (nextTee != null) {
      endCol = nextTee - 1;
      if (matchHeaderKind(header[endCol] || "") === "course") {
        endCol = nextTee - 2;
      }
    } else {
      const gap = prevTee != null ? teeCol - prevTee : 11;
      endCol = Math.max(
        teeCol,
        Math.min(header.length - 1, startCol + Math.max(gap, 11) - 1)
      );
      // 헤더에 남은 관련 열 포함
      for (let c = teeCol + 1; c < header.length; c++) {
        if (matchHeaderKind(header[c] || "")) endCol = Math.max(endCol, c);
      }
    }
    if (endCol < startCol) endCol = startCol;

    const columns: ColumnMap = { teeTime: teeCol };
    for (let c = startCol; c <= endCol; c++) {
      const kind = matchHeaderKind(header[c] || "");
      if (!kind || kind === "teeTime") continue;
      if (columns[kind] == null) columns[kind] = c;
    }

    const defaultCourse = inferBlockDefaultCourse(
      matrix,
      bestRow,
      startCol,
      endCol,
      columns.course ?? null
    );

    blocks.push({
      headerRow: bestRow,
      startCol,
      endCol,
      columns,
      defaultCourse,
    });
  }

  return blocks;
}

/** 단일 테이블 호환: 첫 블록의 헤더/컬럼맵 */
export function detectHeaderRow(
  matrix: string[][],
  maxScanRows = 20
): { headerRow: number; columns: ColumnMap } | null {
  const blocks = detectCourseBlocks(matrix, maxScanRows);
  if (!blocks.length) return null;
  return { headerRow: blocks[0].headerRow, columns: blocks[0].columns };
}

function inferBlockDefaultCourse(
  matrix: string[][],
  headerRow: number,
  startCol: number,
  endCol: number,
  courseCol: number | null
): CourseCode | null {
  // 헤더 위 제목 행에서 코스명 탐색
  for (let r = Math.max(0, headerRow - 3); r < headerRow; r++) {
    const row = matrix[r] || [];
    for (let c = startCol; c <= endCol; c++) {
      const hit = normalizeCourse(row[c] || "");
      if (hit) return hit;
    }
  }
  // 데이터 행의 코스 열에서 첫 유효 값
  if (courseCol != null) {
    for (let r = headerRow + 1; r < Math.min(matrix.length, headerRow + 40); r++) {
      const hit = normalizeCourse((matrix[r] || [])[courseCol] || "");
      if (hit) return hit;
    }
  }
  // 블록 안 임의 셀
  for (let r = headerRow + 1; r < Math.min(matrix.length, headerRow + 15); r++) {
    const row = matrix[r] || [];
    for (let c = startCol; c <= endCol; c++) {
      const hit = normalizeCourse(row[c] || "");
      if (hit) return hit;
    }
  }
  return null;
}

function isBlankBlockRange(
  values: unknown[],
  startCol: number,
  endCol: number
): boolean {
  for (let c = startCol; c <= endCol; c++) {
    if (cellText(values[c]) !== "") return false;
  }
  return true;
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

/**
 * @deprecated 실제 경기진행등록.xls에는 명시적 1부/2부/3부 셀이 없음.
 * shift는 buildRowShiftMap(티타임 gap 밴드)으로만 판정. 부 전용 컬럼 테스트용으로만 유지.
 */
export function detectShiftSectionLabel(
  values: unknown[],
  startCol: number,
  endCol: number
): ShiftPart | null {
  if (!values?.length) return null;
  const lo = Math.max(0, startCol);
  const hi = Math.min(endCol, values.length - 1);
  let found: ShiftPart | null = null;
  for (let c = lo; c <= hi; c++) {
    const hit = detectExplicitShiftLabel(cellText(values[c]));
    if (hit) found = hit;
  }
  return found;
}

/** @deprecated detectShiftSectionLabel과 동일 — 섹션 셀 전제 폐기 */
export function detectRowShiftSectionLabel(values: unknown[]): ShiftPart | null {
  if (!values?.length) return null;
  return detectShiftSectionLabel(values, 0, values.length - 1);
}

export function teeTimeToMinutes(teeTime: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(teeTime);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

function medianSorted(sorted: number[]): number {
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

/**
 * 인접 행 gap 중 “연속 티타임(~7분) 대비 현저히 큰 gap” 인덱스를 찾는다.
 * 절대 시각 threshold(<12시 등)는 사용하지 않음.
 * @returns gaps[i] = rowTimes[i+1]-rowTimes[i] 가 밴드 경계일 때 i 목록
 */
export function findTeeBandBreakIndices(gapsMinutes: number[]): number[] {
  if (!gapsMinutes.length) return [];
  // 밴드 내부 간격 후보 (현장 ~7분, 여유 있게 ≤45분)
  const small = gapsMinutes.filter((g) => g > 0 && g <= 45).sort((a, b) => a - b);
  const medianSmall = small.length ? medianSorted(small) : 7;
  // 연속 간격의 수 배 이상이면서 최소 90분 이상 → 밴드 분리 (~3시간 공백)
  const threshold = Math.max(90, medianSmall * 8);
  const breaks: number[] = [];
  for (let i = 0; i < gapsMinutes.length; i++) {
    if (gapsMinutes[i] >= threshold) breaks.push(i);
  }
  return breaks;
}

type RowTeeSample = { row: number; minutes: number; teeTime: string };

/**
 * 시트 공통 티타임 밴드로 행→shift 맵 생성.
 * - 4코스 블록의 teeTime을 행 단위로 모아 대표 시각(최소) 사용
 * - 큰 시간 gap으로 정확히 3밴드가 되면 순서대로 1/2/3부
 * - 3밴드가 아니면 전부 null (SHIFT_NOT_DETECTED) — 임의 부여 금지
 * - 명시적 N부 셀·절대 시각·bare 1/2/3·캐디명 미사용
 */
export function buildRowShiftMap(
  matrix: unknown[][],
  blocks?: CourseBlock[]
): Array<ShiftPart | null> {
  const map: Array<ShiftPart | null> = new Array(matrix.length).fill(null);
  const stringMatrix = matrix.map((row) => row.map((c) => cellText(c)));
  const courseBlocks = blocks ?? detectCourseBlocks(stringMatrix);
  if (!courseBlocks.length) return map;

  const headerRow = Math.min(...courseBlocks.map((b) => b.headerRow));
  const samples: RowTeeSample[] = [];

  for (let r = headerRow + 1; r < matrix.length; r++) {
    const values = matrix[r] || [];
    // 반복 헤더 행 제외
    let headerHits = 0;
    for (const block of courseBlocks) {
      for (let c = block.startCol; c <= block.endCol; c++) {
        if (matchHeaderKind(cellText(values[c]))) headerHits += 1;
      }
    }
    if (headerHits >= 2) continue;

    const mins: number[] = [];
    let sampleTee = "";
    for (const block of courseBlocks) {
      const col = block.columns.teeTime;
      if (col == null) continue;
      const tee = parseTeeTime(values[col]);
      if (!tee) continue;
      const m = teeTimeToMinutes(tee);
      if (m == null) continue;
      mins.push(m);
      if (!sampleTee || m < teeTimeToMinutes(sampleTee)!) sampleTee = tee;
    }
    if (!mins.length) continue;
    samples.push({
      row: r,
      minutes: Math.min(...mins),
      teeTime: sampleTee,
    });
  }

  if (samples.length < 3) return map;

  const gaps: number[] = [];
  for (let i = 0; i < samples.length - 1; i++) {
    gaps.push(samples[i + 1].minutes - samples[i].minutes);
  }
  const breaks = findTeeBandBreakIndices(gaps);
  // 정확히 2개의 큰 gap → 3밴드만 인정
  if (breaks.length !== 2) return map;

  const b0 = breaks[0];
  const b1 = breaks[1];
  const bands: Array<{ shift: ShiftPart; rows: RowTeeSample[] }> = [
    { shift: "1부", rows: samples.slice(0, b0 + 1) },
    { shift: "2부", rows: samples.slice(b0 + 1, b1 + 1) },
    { shift: "3부", rows: samples.slice(b1 + 1) },
  ];
  if (bands.some((b) => b.rows.length === 0)) return map;

  for (const band of bands) {
    const start = band.rows[0].row;
    const end = band.rows[band.rows.length - 1].row;
    for (let r = start; r <= end; r++) {
      map[r] = band.shift;
    }
  }
  return map;
}

export function parseReservationMatrix(
  matrix: unknown[][],
  options: {
    sourceSheet: string;
    defaultDate?: string | null;
    defaultCourse?: CourseCode | null;
    /** @deprecated 무시됨 — 티타임 밴드/부 컬럼만 사용 */
    defaultShift?: ShiftPart | null;
  }
): ParsedReservation[] {
  const stringMatrix = matrix.map((row) => row.map((c) => cellText(c)));
  const blocks = detectCourseBlocks(stringMatrix);
  if (!blocks.length) return [];

  const sheetCtx = inferContextFromSheetName(options.sourceSheet);
  const fallbackDate = options.defaultDate || sheetCtx.date;
  const sheetCourse = options.defaultCourse || sheetCtx.course;
  // 시트 공통 티타임 밴드 (4코스가 같은 행의 shift를 공유)
  const rowShiftMap = buildRowShiftMap(matrix, blocks);

  const out: ParsedReservation[] = [];
  for (const block of blocks) {
    out.push(
      ...parseCourseBlock(matrix, stringMatrix, block, {
        sourceSheet: options.sourceSheet,
        fallbackDate,
        sheetCourse,
        rowShiftMap,
      })
    );
  }
  return out;
}

function parseCourseBlock(
  matrix: unknown[][],
  stringMatrix: string[][],
  block: CourseBlock,
  ctx: {
    sourceSheet: string;
    fallbackDate: string | null;
    sheetCourse: CourseCode | null;
    rowShiftMap: Array<ShiftPart | null>;
  }
): ParsedReservation[] {
  const { headerRow, columns, startCol, endCol } = block;
  const headerLabels = stringMatrix[headerRow] || [];
  const blockCourse = block.defaultCourse || ctx.sheetCourse;
  const out: ParsedReservation[] = [];

  for (let r = headerRow + 1; r < matrix.length; r++) {
    const values = matrix[r] || [];

    // 이 코스 블록이 비어 있으면 skip (다른 코스 때문에 shift를 바꾸지 않음)
    if (isBlankBlockRange(values, startCol, endCol)) continue;

    // 블록 범위 안 반복 헤더 행 스킵
    let headerHits = 0;
    for (let c = startCol; c <= endCol; c++) {
      if (matchHeaderKind(cellText(values[c]))) headerHits += 1;
    }
    if (headerHits >= 2) continue;

    const teamRaw =
      columns.teamName != null ? cellText(values[columns.teamName]) : "";
    const teamName = teamRaw || null;
    // 예약자/팀명 없는 행은 예약으로 세지 않음 (섹션 라벨·공석 티)
    if (!teamName) continue;

    const courseRaw =
      columns.course != null ? cellText(values[columns.course]) : "";

    const teeRaw =
      columns.teeTime != null ? values[columns.teeTime] : undefined;
    const teeTime = parseTeeTime(teeRaw);
    const dateRaw = columns.date != null ? values[columns.date] : undefined;
    const date = parseDateValue(dateRaw) || ctx.fallbackDate || null;

    // 시간·코스·날짜 단서가 전혀 없으면 스킵
    if (!teeTime && !courseRaw && !dateRaw) continue;

    const rawData = buildRawData(headerLabels, values, columns);
    const reviewReasons: string[] = [];

    if (!teeTime) reviewReasons.push("잘못된 시간 형식");
    if (!date) reviewReasons.push("날짜 없음");

    const course = normalizeCourse(courseRaw) || blockCourse;
    if (!course) reviewReasons.push("코스 판별 실패");

    const shiftRaw =
      columns.shift != null ? cellText(values[columns.shift]) : "";
    // 전용 부 컬럼(명시 N부, 드묾) → 아니면 시트 공통 티타임 밴드.
    // 절대시각 threshold / 빈행 순서 / 1부 fallback 없음.
    const shift: ShiftPart | null =
      normalizeShiftColumn(shiftRaw) || ctx.rowShiftMap[r] || null;
    if (!shift) reviewReasons.push(SHIFT_NOT_DETECTED);

    const hole =
      columns.hole != null ? parseHoleValue(values[columns.hole]) : null;
    const startingHole =
      columns.startingHole != null
        ? parseHoleValue(values[columns.startingHole])
        : null;

    out.push({
      date: date || "",
      course,
      courseLabel: course ? COURSE_LABELS[course] : "미상",
      shift,
      teeTime: teeTime || cellText(teeRaw),
      teamName,
      hole,
      startingHole,
      sourceSheet: ctx.sourceSheet,
      rawRowIndex: r + 1,
      rawData,
      needsReview: reviewReasons.length > 0,
      reviewReasons,
      isDuplicate: false,
      duplicateKey: null,
    });
  }

  return out;
}

function reservationDupeKey(row: ParsedReservation): string {
  return [
    row.date,
    row.course ?? "",
    row.teeTime,
    row.startingHole ?? "",
  ].join("|");
}

export function markDuplicates(rows: ParsedReservation[]): ParsedReservation[] {
  const keyCount = new Map<string, number>();
  for (const row of rows) {
    if (!row.date || !row.teeTime || row.needsReview || !row.course) continue;
    const key = reservationDupeKey(row);
    keyCount.set(key, (keyCount.get(key) || 0) + 1);
  }

  return rows.map((row) => {
    if (!row.date || !row.teeTime || row.needsReview || !row.course) return row;
    const key = reservationDupeKey(row);
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
  const valid = rows.filter(
    (r) =>
      !r.needsReview &&
      r.date &&
      r.teeTime &&
      r.course &&
      r.teamName &&
      r.shift
  );
  const dates = [...new Set(valid.map((r) => r.date))].sort();

  const byDate = dates.map((date) => {
    const dayRows = valid.filter((r) => r.date === date);
    const byShift = emptyShiftCounts();
    for (const r of dayRows) {
      if (r.shift) byShift[r.shift] += 1;
    }

    const courses = COURSE_CODES.filter((c) =>
      dayRows.some((r) => r.course === c)
    );
    const byCourse = courses.map((course) => {
      const courseRows = dayRows.filter((r) => r.course === course);
      const shiftCounts = emptyShiftCounts();
      for (const r of courseRows) {
        if (r.shift) shiftCounts[r.shift] += 1;
      }
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
    const ra = a.course != null ? courseRank[a.course] : 999;
    const rb = b.course != null ? courseRank[b.course] : 999;
    if (ra !== rb) return ra - rb;
    const sa = a.shift != null ? shiftRank[a.shift] : 999;
    const sb = b.shift != null ? shiftRank[b.shift] : 999;
    if (sa !== sb) return sa - sb;
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

