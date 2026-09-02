/**
 * 당번·마샬·조장 Google Spreadsheet 파서 (셀 값만, DB write 없음)
 * 탭 이름은 의미가 없다. 복사용/사용안내는 항상 제외하고 날짜·역할명을 검색한다.
 */

import {
  type DutyExcelEntry,
  type DutyExcelParseResult,
  type DutyRoleKind,
} from "@/lib/dutyMarshalLeaderParser";
import { parseDateValue } from "@/lib/reservationParser";
import { normalizePersonName, splitPersonNames } from "@/lib/dailyCaddyNameMatch";
import type { MatchedOpsDutyRow, OpsDutyReview } from "@/lib/dailyOpsDuty";

const ROLE_BY_KEY: Record<string, DutyRoleKind> = {
  당번_조출_1: "duty_am",
  당번_조출_2: "duty_am",
  당번_후출_1: "duty_pm",
  당번_후출_2: "duty_pm",
  마샬_조출_1: "marshal_am",
  마샬_조출_2: "marshal_am",
  마샬_후출_1: "marshal_pm",
  조장_1: "leader",
};

export type OpsDutySheet = { name: string; matrix: unknown[][] };

export const OPS_DUTY_SKIP_TAB_NAMES = ["복사용", "사용안내"] as const;

export const OPS_DUTY_SHEET_SLOT_DEFS = [
  { roleKey: "당번_조출_1", kind: "duty_am" as const, label: "당번 조출 1" },
  { roleKey: "당번_조출_2", kind: "duty_am" as const, label: "당번 조출 2" },
  { roleKey: "당번_후출_1", kind: "duty_pm" as const, label: "당번 후출 1" },
  { roleKey: "당번_후출_2", kind: "duty_pm" as const, label: "당번 후출 2" },
  { roleKey: "마샬_조출_1", kind: "marshal_am" as const, label: "마샬 조출 1" },
  { roleKey: "마샬_조출_2", kind: "marshal_am" as const, label: "마샬 조출 2" },
  { roleKey: "마샬_후출_1", kind: "marshal_pm" as const, label: "마샬 후출 1" },
  { roleKey: "조장_1", kind: "leader" as const, label: "조장" },
] as const;

export type OpsDutySheetSlotDef = (typeof OPS_DUTY_SHEET_SLOT_DEFS)[number];

const ROLE_KEY_BY_NORMALIZED: Record<string, string> = {
  당번조출1: "당번_조출_1",
  당번조출2: "당번_조출_2",
  당번후출1: "당번_후출_1",
  당번후출2: "당번_후출_2",
  마샬조출1: "마샬_조출_1",
  마샬조출2: "마샬_조출_2",
  마샬후출1: "마샬_후출_1",
  조장: "조장_1",
  조장1: "조장_1",
};

const SKIP_ROW_LABELS = new Set([
  "구분",
  "시작일",
  "입력수",
  "메모",
  "1구간운영",
  "2구간운영",
]);

export class OpsDutySheetError extends Error {
  status = 400;
  code = "ops_duty_sheet_invalid";
  constructor(message: string, code?: string, status?: number) {
    super(message);
    this.name = "OpsDutySheetError";
    if (code) this.code = code;
    if (typeof status === "number") this.status = status;
  }
}

export function isSkippedOpsDutyTabName(name: unknown): boolean {
  const normalized = String(name ?? "")
    .replace(/\u00a0/g, " ")
    .trim();
  return (OPS_DUTY_SKIP_TAB_NAMES as readonly string[]).includes(normalized);
}

/** 공백·가운데점 차이를 접고 역할 8개만 정확 매핑. 섹션 제목(당번/마샬/조장 단독 중 당번·마샬)은 제외. */
export function normalizeOpsDutyRoleKey(raw: unknown): string | null {
  const text = String(raw ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/[·•・･∙⋅]/g, "")
    .replace(/[_\s]+/g, "")
    .trim();
  if (!text) return null;
  return ROLE_KEY_BY_NORMALIZED[text] || null;
}

function cellText(value: unknown): string {
  if (value == null) return "";
  return String(value).replace(/\u00a0/g, " ").trim();
}

function ymdFromOpsDutyCell(value: unknown, selectedYmd: string): string | null {
  const parsed = parseDateValue(value);
  if (parsed) return parsed;
  const text = cellText(value);
  if (!text) return null;
  const ymd = text.match(
    /(\d{4})[.\-\/](\d{1,2})[.\-\/](\d{1,2})(?:\s*\([^)]+\))?/
  );
  if (ymd) {
    return `${ymd[1]}-${ymd[2].padStart(2, "0")}-${ymd[3].padStart(2, "0")}`;
  }
  const korean = text.match(/(\d{1,2})\s*월\s*(\d{1,2})\s*일/);
  if (korean) {
    const year = selectedYmd.slice(0, 4);
    return `${year}-${korean[1].padStart(2, "0")}-${korean[2].padStart(2, "0")}`;
  }
  const md = text.match(/^(\d{1,2})[.\-\/](\d{1,2})(?:\s*\([^)]+\))?\s*$/);
  if (md) {
    const year = selectedYmd.slice(0, 4);
    return `${year}-${md[1].padStart(2, "0")}-${md[2].padStart(2, "0")}`;
  }
  return null;
}

function normalizedRowLabel(row: unknown[] | undefined): string {
  if (!row) return "";
  for (const cell of row) {
    const text = cellText(cell)
      .replace(/[·•・･∙⋅]/g, "")
      .replace(/[_\s]+/g, "");
    if (text) return text;
  }
  return "";
}

function isStartDateRow(row: unknown[] | undefined): boolean {
  if (!row) return false;
  return row.some((cell) => cellText(cell).replace(/\s+/g, "") === "시작일");
}

type DateHit = { row: number; col: number; ymd: string };

function dateHitsInRow(
  row: unknown[] | undefined,
  selectedYmd: string
): DateHit[] {
  if (!row) return [];
  const out: DateHit[] = [];
  for (let c = 0; c < row.length; c++) {
    const ymd = ymdFromOpsDutyCell(row[c], selectedYmd);
    if (ymd) out.push({ row: -1, col: c, ymd });
  }
  return out;
}

function isDateHeaderRow(row: unknown[] | undefined, selectedYmd: string): boolean {
  if (!row || isStartDateRow(row)) return false;
  const hits = dateHitsInRow(row, selectedYmd);
  if (hits.length >= 2) return true;
  const label = normalizedRowLabel(row);
  return label === "구분" && hits.length >= 1;
}

function nameFromCell(value: unknown): string {
  const names = splitPersonNames(value);
  return names[0] || normalizePersonName(value);
}

export type OpsDutySheetDateLocation = {
  sheetName: string;
  row: number;
  col: number;
  ymd: string;
};

export type OpsDutySheetParseResult = DutyExcelParseResult & {
  sheetName: string;
  dateRow: number;
  locations: OpsDutySheetDateLocation[];
};

function parseOneOperationalSheet(
  sheetName: string,
  matrix: unknown[][],
  selectedYmd: string
): {
  entriesByDateCol: Map<
    number,
    { dateRow: number; col: number; ymd: string; entries: DutyExcelEntry[] }
  >;
  dates: OpsDutySheetDateLocation[];
} {
  const headerRows: number[] = [];
  for (let r = 0; r < matrix.length; r++) {
    if (isDateHeaderRow(matrix[r], selectedYmd)) headerRows.push(r);
  }

  const dates: OpsDutySheetDateLocation[] = [];
  const entriesByDateCol = new Map<
    number,
    { dateRow: number; col: number; ymd: string; entries: DutyExcelEntry[] }
  >();

  for (let h = 0; h < headerRows.length; h++) {
    const headerRow = headerRows[h];
    const blockEnd = h + 1 < headerRows.length ? headerRows[h + 1] : matrix.length;
    const hits = dateHitsInRow(matrix[headerRow], selectedYmd).map((hit) => ({
      ...hit,
      row: headerRow,
    }));
    const minDateCol = hits.reduce((min, hit) => Math.min(min, hit.col), Number.POSITIVE_INFINITY);

    const roleRows: Array<{ row: number; roleKey: string; kind: DutyRoleKind }> = [];
    for (let r = headerRow + 1; r < blockEnd; r++) {
      const row = matrix[r] || [];
      if (isDateHeaderRow(row, selectedYmd)) continue;
      const label = normalizedRowLabel(row);
      if (SKIP_ROW_LABELS.has(label)) continue;
      let found: { roleKey: string; kind: DutyRoleKind } | null = null;
      const searchUntil = Number.isFinite(minDateCol) ? minDateCol : row.length;
      for (let c = 0; c < searchUntil; c++) {
        const roleKey = normalizeOpsDutyRoleKey(row[c]);
        if (!roleKey) continue;
        const kind = ROLE_BY_KEY[roleKey];
        if (!kind) continue;
        found = { roleKey, kind };
        break;
      }
      if (!found) continue;
      roleRows.push({ row: r, ...found });
    }

    for (const hit of hits) {
      dates.push({ sheetName, row: hit.row, col: hit.col, ymd: hit.ymd });
      const named: DutyExcelEntry[] = [];
      const namedKeys = new Set<string>();
      const duplicateKeys = new Set<string>();
      for (const role of roleRows) {
        const rawName = nameFromCell(matrix[role.row]?.[hit.col]);
        if (!rawName) continue;
        if (namedKeys.has(role.roleKey)) {
          duplicateKeys.add(role.roleKey);
          continue;
        }
        namedKeys.add(role.roleKey);
        named.push({
          kind: role.kind,
          roleKey: role.roleKey,
          rawName,
        });
      }
      if (duplicateKeys.size > 0) {
        throw new OpsDutySheetError(
          `탭 "${sheetName}" ${hit.ymd}에 역할이 중복됩니다: ${[...duplicateKeys].join(", ")}`,
          "ops_duty_sheet_duplicate_role",
          400
        );
      }
      entriesByDateCol.set(hit.col * 10000 + hit.row, {
        dateRow: hit.row,
        col: hit.col,
        ymd: hit.ymd,
        entries: named,
      });
    }
  }

  return { entriesByDateCol, dates };
}

/** 운영/제외 탭의 날짜 셀만 수집. 역할 중복은 throw하지 않는다. */
export function scanOpsDutySheetDates(
  sheets: readonly OpsDutySheet[],
  selectedYmd: string
): {
  operational: OpsDutySheetDateLocation[];
  skipped: OpsDutySheetDateLocation[];
} {
  const operational: OpsDutySheetDateLocation[] = [];
  const skipped: OpsDutySheetDateLocation[] = [];
  for (const sheet of sheets) {
    const matrix = sheet.matrix || [];
    const dates: OpsDutySheetDateLocation[] = [];
    for (let r = 0; r < matrix.length; r++) {
      if (!isDateHeaderRow(matrix[r], selectedYmd)) continue;
      for (const hit of dateHitsInRow(matrix[r], selectedYmd)) {
        dates.push({ sheetName: sheet.name, row: r, col: hit.col, ymd: hit.ymd });
      }
    }
    if (isSkippedOpsDutyTabName(sheet.name)) skipped.push(...dates);
    else operational.push(...dates);
  }
  return { operational, skipped };
}

export function parseOpsDutySheetsForDate(
  sheets: readonly OpsDutySheet[],
  selectedYmd: string
): OpsDutySheetParseResult {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(selectedYmd)) {
    throw new OpsDutySheetError("date must be YYYY-MM-DD", "ops_duty_sheet_invalid", 400);
  }

  const operational = sheets.filter((sheet) => !isSkippedOpsDutyTabName(sheet.name));
  const matches: Array<{
    sheetName: string;
    dateRow: number;
    col: number;
    entries: DutyExcelEntry[];
  }> = [];

  for (const sheet of operational) {
    const parsed = parseOneOperationalSheet(
      sheet.name,
      sheet.matrix || [],
      selectedYmd
    );
    const sameDate = parsed.dates.filter((d) => d.ymd === selectedYmd);
    if (sameDate.length > 1) {
      throw new OpsDutySheetError(
        `탭 "${sheet.name}"에 ${selectedYmd} 날짜가 두 곳 이상 있습니다.`,
        "ops_duty_sheet_duplicate_date",
        400
      );
    }
    if (sameDate.length === 1) {
      const loc = sameDate[0];
      const block = [...parsed.entriesByDateCol.values()].find(
        (b) => b.ymd === selectedYmd && b.col === loc.col && b.dateRow === loc.row
      );
      matches.push({
        sheetName: sheet.name,
        dateRow: loc.row,
        col: loc.col,
        entries: block?.entries || [],
      });
    }
  }

  if (matches.length === 0) {
    throw new OpsDutySheetError(
      `선택한 날짜 ${selectedYmd}를 운영 탭에서 찾지 못했습니다. 복사용/사용안내 탭은 제외됩니다.`,
      "ops_duty_sheet_date_not_found",
      400
    );
  }
  if (matches.length > 1) {
    throw new OpsDutySheetError(
      `${selectedYmd} 날짜가 운영 탭 여러 곳에 있습니다: ${matches
        .map((m) => m.sheetName)
        .join(", ")}`,
      "ops_duty_sheet_duplicate_date",
      400
    );
  }

  const hit = matches[0];
  return {
    date: selectedYmd,
    entries: hit.entries,
    dateColumn: hit.col,
    sheetName: hit.sheetName,
    dateRow: hit.dateRow,
    locations: [{ sheetName: hit.sheetName, row: hit.dateRow, col: hit.col, ymd: selectedYmd }],
  };
}

export type OpsDutySheetSlot = {
  roleKey: string;
  label: string;
  rawName: string;
  matchedName: string | null;
  caddyId: number | null;
  status: "empty" | "matched" | "review";
  reason: string | null;
};

export function buildOpsDutySheetSlots(input: {
  entries: readonly DutyExcelEntry[];
  matched: readonly MatchedOpsDutyRow[];
  reviews: readonly OpsDutyReview[];
}): OpsDutySheetSlot[] {
  const entryByKey = new Map(input.entries.map((e) => [e.roleKey, e]));
  const matchedByKey = new Map(input.matched.map((m) => [m.roleKey, m]));
  const reviewByKey = new Map(input.reviews.map((r) => [r.roleKey, r]));
  return OPS_DUTY_SHEET_SLOT_DEFS.map((def) => {
    const entry = entryByKey.get(def.roleKey);
    const matched = matchedByKey.get(def.roleKey);
    const review = reviewByKey.get(def.roleKey);
    if (review) {
      return {
        roleKey: def.roleKey,
        label: def.label,
        rawName: review.rawName || entry?.rawName || "",
        matchedName: null,
        caddyId: null,
        status: "review" as const,
        reason: review.reason,
      };
    }
    if (matched) {
      return {
        roleKey: def.roleKey,
        label: def.label,
        rawName: matched.rawName,
        matchedName: matched.name,
        caddyId: matched.caddyId,
        status: "matched" as const,
        reason: null,
      };
    }
    return {
      roleKey: def.roleKey,
      label: def.label,
      rawName: entry?.rawName || "",
      matchedName: null,
      caddyId: null,
      status: "empty" as const,
      reason: null,
    };
  });
}

export function opsDutySheetApplyBlockReason(input: {
  reviews: readonly OpsDutyReview[];
  matched: readonly MatchedOpsDutyRow[];
}): string | null {
  if (input.reviews.length > 0) {
    return `확인 필요 ${input.reviews.length}건이 있어 적용할 수 없습니다. 동명이인·미매칭은 저장하지 않습니다.`;
  }
  if (input.matched.length === 0) {
    return "저장할 매칭 결과가 없습니다.";
  }
  return null;
}

/** 가용 불러오기 자동동기화: 8슬롯 전부 exact ACTIVE, 리뷰 없음. */
export function isOpsDutySheetAutoApplyReady(input: {
  entries: readonly DutyExcelEntry[];
  matched: readonly MatchedOpsDutyRow[];
  reviews: readonly OpsDutyReview[];
}): boolean {
  if (input.reviews.length > 0) return false;
  if (input.matched.length !== OPS_DUTY_SHEET_SLOT_DEFS.length) return false;
  if (input.entries.length !== OPS_DUTY_SHEET_SLOT_DEFS.length) return false;
  const matchedKeys = new Set(input.matched.map((row) => row.roleKey));
  return OPS_DUTY_SHEET_SLOT_DEFS.every((def) => matchedKeys.has(def.roleKey));
}

export type OpsDutySheetTestDayNames = Partial<Record<string, string>>;

export type OpsDutySheetTestTab = {
  name: string;
  startDate?: unknown;
  week1Dates: unknown[];
  week2Dates: unknown[];
  week1Names?: OpsDutySheetTestDayNames[];
  week2Names?: OpsDutySheetTestDayNames[];
};

const WEEK_ROLE_ORDER = [
  { label: "당번", key: null },
  { label: "당번 · 조출 1", key: "당번_조출_1" },
  { label: "당번 · 조출 2", key: "당번_조출_2" },
  { label: "당번 · 후출 1", key: "당번_후출_1" },
  { label: "당번 · 후출 2", key: "당번_후출_2" },
  { label: "", key: null },
  { label: "마샬", key: null },
  { label: "마샬 · 조출 1", key: "마샬_조출_1" },
  { label: "마샬 · 조출 2", key: "마샬_조출_2" },
  { label: "마샬 · 후출 1", key: "마샬_후출_1" },
  { label: "", key: null },
  { label: "조장", key: null },
  { label: "조장", key: "조장_1" },
] as const;

function namesForRole(
  days: OpsDutySheetTestDayNames[] | undefined,
  roleKey: string,
  count: number
): unknown[] {
  const out: unknown[] = [];
  for (let i = 0; i < count; i++) {
    out.push(days?.[i]?.[roleKey] ?? "");
  }
  return out;
}

/** 실제 운영표와 비슷한 14일(7+7) 탭 매트릭스. 행 번호에 의존하지 않는 파서 검증용. */
export function buildOpsDutySheetTestMatrix(tab: OpsDutySheetTestTab): unknown[][] {
  const w1 = tab.week1Dates || [];
  const w2 = tab.week2Dates || [];
  const matrix: unknown[][] = [
    ["", "VERTHILL · 당번 · 마샬 · 조장 운영표"],
    ["", "이 탭을 복사한 뒤 시작일만 변경해서 사용 · 색상/글꼴/테두리 변경 가능"],
    ["", "시작일", tab.startDate ?? w1[0] ?? "", "새 탭에서는 C3의 시작일만 바꾸면 아래 14일 날짜가 자동 변경됩니다."],
    [],
    ["", "1구간 운영"],
    ["", "구분", ...w1, "메모"],
  ];
  for (const role of WEEK_ROLE_ORDER) {
    matrix.push([
      "",
      role.label,
      ...(role.key ? namesForRole(tab.week1Names, role.key, w1.length) : w1.map(() => "")),
    ]);
  }
  matrix.push(["", "입력수", ...w1.map(() => 0)]);
  matrix.push([]);
  matrix.push(["", "2구간 운영"]);
  matrix.push(["", "구분", ...w2, "메모"]);
  for (const role of WEEK_ROLE_ORDER) {
    matrix.push([
      "",
      role.label,
      ...(role.key ? namesForRole(tab.week2Names, role.key, w2.length) : w2.map(() => "")),
    ]);
  }
  matrix.push(["", "입력수", ...w2.map(() => 0)]);
  return matrix;
}

export function buildOpsDutySheetTestSheets(
  tabs: OpsDutySheetTestTab[]
): OpsDutySheet[] {
  return tabs.map((tab) => ({
    name: tab.name,
    matrix: buildOpsDutySheetTestMatrix(tab),
  }));
}
