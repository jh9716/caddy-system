/**
 * 운영 휴무 Google Sheet 파서 (읽기 전용, 순수 함수)
 * 실제 구조: 시트=기간탭, 날짜 행 + 다음 행 N조 헤더 + 그 아래 이름
 */

import { parseDateValue } from "@/lib/reservationParser";
import { splitPersonNames } from "@/lib/dailyCaddyNameMatch";

export type OffSheet = { name: string; matrix: unknown[][] };

export type ParsedOffSheetNames = {
  namesByDate: Map<string, string[]>;
  seenDates: Set<string>;
};

const TEAM_HEADER = /^(\d{1,2})\s*조$/;
const DATE_IN_TEXT =
  /(\d{4})\s*[.\-\/]\s*(\d{1,2})\s*[.\-\/]\s*(\d{1,2})/;

export function parseOffSheetDateCell(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (value instanceof Date || typeof value === "number") {
    return parseDateValue(value);
  }
  const text = String(value).replace(/\u00a0/g, " ").trim();
  const m = text.match(DATE_IN_TEXT);
  if (!m) return null;
  return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
}

function cellStr(value: unknown): string {
  if (value == null) return "";
  return String(value).replace(/\u00a0/g, " ").trim();
}

function isTeamHeader(value: unknown): boolean {
  return TEAM_HEADER.test(cellStr(value).replace(/\s+/g, ""));
}

function datesInRow(row: unknown[] | undefined): Array<{ col: number; ymd: string }> {
  if (!row) return [];
  const out: Array<{ col: number; ymd: string }> = [];
  for (let c = 0; c < row.length; c++) {
    const ymd = parseOffSheetDateCell(row[c]);
    if (ymd) out.push({ col: c, ymd });
  }
  return out;
}

function dateForColumn(
  col: number,
  starts: Array<{ col: number; ymd: string }>
): string | null {
  let best: { col: number; ymd: string } | null = null;
  for (const s of starts) {
    if (s.col <= col && (!best || s.col > best.col)) best = s;
  }
  return best?.ymd ?? null;
}

/**
 * 모든 시트를 스캔해 날짜 → 휴무 이름 목록.
 * 조 헤더가 아닌 열(장기휴무 등)은 버림.
 * seenDates: 날짜 헤더가 실제 휴무 블록(이후 N조 헤더)과 연결된 ymd.
 * namesByDate: 실제 이름이 1명 이상인 날짜만 키를 가짐.
 */
export function parseOffSheetsToNamesByDate(
  sheets: readonly OffSheet[]
): ParsedOffSheetNames {
  const namesByDate = new Map<string, string[]>();
  const seenDates = new Set<string>();
  const push = (ymd: string, name: string) => {
    const list = namesByDate.get(ymd) ?? [];
    if (!list.includes(name)) list.push(name);
    namesByDate.set(ymd, list);
  };

  for (const sheet of sheets) {
    const matrix = sheet.matrix || [];
    let dateStarts: Array<{ col: number; ymd: string }> = [];
    let teamCols = new Map<number, string>();

    for (const row of matrix) {
      const dates = datesInRow(row);
      if (dates.length > 0) {
        dateStarts = dates;
        teamCols = new Map();
        continue;
      }
      if (dateStarts.length === 0) continue;

      const teamHits = (row || []).filter((c) => isTeamHeader(c)).length;
      if (teamHits >= 2) {
        teamCols = new Map();
        for (let c = 0; c < (row || []).length; c++) {
          if (isTeamHeader(row[c])) teamCols.set(c, cellStr(row[c]));
        }
        for (const d of dateStarts) seenDates.add(d.ymd);
        continue;
      }
      if (teamCols.size === 0) continue;

      for (const [c] of teamCols) {
        const ymd = dateForColumn(c, dateStarts);
        if (!ymd) continue;
        for (const name of splitPersonNames(row?.[c])) {
          if (TEAM_HEADER.test(name)) continue;
          if (name === "장기휴무" || name === "장기휴가" || name === "휴무자명단") continue;
          push(ymd, name);
        }
      }
    }
  }

  return { namesByDate, seenDates };
}

export function offNamesForDate(
  sheets: readonly OffSheet[],
  ymd: string
): { names: string[]; matchedSheetDates: string[] } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) {
    throw new Error("date must be YYYY-MM-DD");
  }
  const { namesByDate, seenDates } = parseOffSheetsToNamesByDate(sheets);
  const names = namesByDate.get(ymd) ?? [];
  return { names, matchedSheetDates: [...seenDates].sort() };
}
