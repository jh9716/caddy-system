/**
 * 당번·마샬·조장 일정 Excel 파서 (xlsx/xlsm, DB write 없음)
 * Sheet: 당번마샬조장
 * 4행 날짜(B~)를 기준으로 selected date 열을 찾음 — 요일/월요일 시작 가정 없음
 */

import * as XLSX from "xlsx";
import { parseDateValue } from "@/lib/reservationParser";
import { normalizePersonName, splitPersonNames } from "@/lib/dailyCaddyNameMatch";

export const DUTY_SHEET_NAME = "당번마샬조장";

export type DutyRoleKind =
  | "duty_am"
  | "duty_pm"
  | "marshal_am"
  | "marshal_pm"
  | "leader";

export const DUTY_ROLE_LABELS: Record<DutyRoleKind, string> = {
  duty_am: "조출당번",
  duty_pm: "후출당번",
  marshal_am: "조출마샬",
  marshal_pm: "후출마샬",
  leader: "조장",
};

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

export type DutyExcelEntry = {
  kind: DutyRoleKind;
  roleKey: string;
  rawName: string;
};

export type DutyExcelParseResult = {
  date: string;
  entries: DutyExcelEntry[];
  dateColumn: number;
};

export class DutyExcelError extends Error {
  status = 400;
  code = "duty_excel_invalid";
  constructor(message: string) {
    super(message);
    this.name = "DutyExcelError";
  }
}

function sheetToMatrix(sheet: XLSX.WorkSheet): unknown[][] {
  const ref = sheet["!ref"];
  if (!ref) return [];
  const range = XLSX.utils.decode_range(ref);
  const matrix: unknown[][] = [];
  for (let r = range.s.r; r <= range.e.r; r++) {
    const row: unknown[] = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = sheet[addr];
      if (!cell) {
        row.push("");
        continue;
      }
      if (cell.t === "n" && typeof cell.v === "number") row.push(cell.v);
      else if (cell.t === "d" && cell.v instanceof Date) row.push(cell.v);
      else row.push(cell.v ?? cell.w ?? "");
    }
    matrix.push(row);
  }
  return matrix;
}

function normalizeRoleKey(raw: unknown): string {
  return String(raw ?? "")
    .replace(/\u00a0/g, " ")
    .trim()
    .replace(/\s+/g, "_");
}

function ymdFromHeader(value: unknown, selectedYmd: string): string | null {
  const parsed = parseDateValue(value);
  if (parsed) return parsed;
  const text = String(value ?? "").replace(/\u00a0/g, " ").trim();
  if (!text) return null;
  const m = text.match(/(\d{4})[.\-\/](\d{1,2})[.\-\/](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  const md = text.match(/^(\d{1,2})[.\-\/](\d{1,2})$/);
  if (md) {
    const year = selectedYmd.slice(0, 4);
    return `${year}-${md[1].padStart(2, "0")}-${md[2].padStart(2, "0")}`;
  }
  return null;
}

export function parseDutyMarshalLeaderMatrix(
  matrix: unknown[][],
  selectedYmd: string
): DutyExcelParseResult {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(selectedYmd)) {
    throw new DutyExcelError("date must be YYYY-MM-DD");
  }
  if (!matrix.length) {
    throw new DutyExcelError("당번마샬조장 시트가 비어 있습니다.");
  }

  const header = matrix[3] || [];
  let dateColumn = -1;
  for (let c = 1; c < header.length; c++) {
    const ymd = ymdFromHeader(header[c], selectedYmd);
    if (ymd === selectedYmd) {
      dateColumn = c;
      break;
    }
  }
  if (dateColumn < 0) {
    throw new DutyExcelError(
      `당번·마샬·조장 파일 4행에서 ${selectedYmd} 날짜 열을 찾지 못했습니다. 실제 날짜 셀을 확인해주세요.`
    );
  }

  const entries: DutyExcelEntry[] = [];
  const seenRole = new Set<string>();
  for (let r = 0; r < matrix.length; r++) {
    if (r === 3) continue;
    const key = normalizeRoleKey(matrix[r]?.[0]);
    const kind = ROLE_BY_KEY[key];
    if (!kind || seenRole.has(key)) continue;
    seenRole.add(key);
    const names = splitPersonNames(matrix[r]?.[dateColumn]);
    const raw = names[0] || normalizePersonName(matrix[r]?.[dateColumn]);
    if (!raw) continue;
    entries.push({ kind, roleKey: key, rawName: raw });
  }

  const required = Object.keys(ROLE_BY_KEY);
  const found = required.filter((k) => seenRole.has(k));
  if (found.length === 0) {
    throw new DutyExcelError(
      "A열에서 당번_조출_1 등 구분 행을 찾지 못했습니다. 시트 구조를 확인해주세요."
    );
  }

  return { date: selectedYmd, entries, dateColumn };
}

export function parseDutyMarshalLeaderWorkbook(
  buffer: Buffer | ArrayBuffer | Uint8Array,
  selectedYmd: string
): DutyExcelParseResult {
  const data =
    buffer instanceof Buffer
      ? buffer
      : Buffer.from(
          buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer
        );
  const workbook = XLSX.read(data, {
    type: "buffer",
    cellDates: true,
    raw: true,
  });
  const sheetName =
    workbook.SheetNames.find((n) => n.trim() === DUTY_SHEET_NAME) ||
    workbook.SheetNames.find((n) => n.replace(/\s+/g, "") === DUTY_SHEET_NAME);
  if (!sheetName) {
    throw new DutyExcelError(
      `시트 "${DUTY_SHEET_NAME}"를 찾지 못했습니다. (파일 시트: ${workbook.SheetNames.join(", ") || "없음"})`
    );
  }
  return parseDutyMarshalLeaderMatrix(
    sheetToMatrix(workbook.Sheets[sheetName]),
    selectedYmd
  );
}

/** 테스트용 xlsx/xlsm 버퍼 */
export function buildDutyMarshalLeaderTestBuffer(
  headerDates: unknown[],
  roleRows: Array<{ key: string; values: unknown[] }>,
  bookType: "xlsx" | "xlsm" = "xlsx"
): Buffer {
  const aoa: unknown[][] = [[""], [""], [""], ["", ...headerDates]];
  for (const row of roleRows) {
    aoa.push([row.key, ...row.values]);
  }
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  XLSX.utils.book_append_sheet(wb, ws, DUTY_SHEET_NAME);
  return Buffer.from(XLSX.write(wb, { type: "buffer", bookType }));
}
