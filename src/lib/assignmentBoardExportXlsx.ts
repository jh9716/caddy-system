/**
 * 배치표 Excel(.xlsx) export.
 * 화면 draft + buildBoardExportSlice 만 직렬화한다.
 * 자동배치 / draft overwrite / publish / confirm / 재배치 / SET·CLEAR·RESTORE 호출 금지.
 * DB·Spreadsheet write 없음.
 */

import * as XLSX from "xlsx";
import {
  BOARD_EXPORT_COURSE_LABELS,
  BOARD_EXPORT_SHIFTS,
  buildBoardExportSlice,
  type BoardExportSlice,
} from "@/lib/assignmentBoardExport";
import type { AssignmentDraft } from "@/lib/assignmentDraft";
import type { AssignmentKind, AutoAssignmentRow } from "@/lib/autoAssignEngine";
import {
  DAILY_SPECIAL_SUPPORT_KIND_BADGES,
  parseSupportKindInput,
  parseSupportWorkPatternInput,
  type DailySpecialSupportKind,
  type DailySpecialSupportWorkPattern,
} from "@/lib/dailySpecialSupport";
import {
  COURSE_CODES,
  type CourseCode,
  type ShiftPart,
} from "@/lib/reservationParser";

export const BOARD_XLSX_TITLE = "VERTHILL 배치표";
export const BOARD_XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const BOARD_XLSX_TABLE_HEADERS = [
  "시간",
  ...COURSE_CODES.map((code) => BOARD_EXPORT_COURSE_LABELS[code]),
] as const;
/** AOA 0-index: 제목 3행 + 빈 행 + 헤더 */
export const BOARD_XLSX_HEADER_ROW = 4;
export const BOARD_XLSX_DATA_START_ROW = 5;

const LINKED_KIND_TAG: Partial<Record<AssignmentKind, string>> = {
  oneTwo: "1·2",
  twoThree: "2·3",
  oneThree: "1·3",
  fiftyFourHole: "54",
};

/** 화면 metadata → 짧은 접미사. SPECIAL_SUPPORT는 V1 예시를 따라 [지원]. */
const SUPPORT_KIND_TAG: Record<DailySpecialSupportKind, string> = {
  CHAGEUN: DAILY_SPECIAL_SUPPORT_KIND_BADGES.CHAGEUN,
  SPECIAL_SUPPORT: "지원",
  OFF_SUPPORT: DAILY_SPECIAL_SUPPORT_KIND_BADGES.OFF_SUPPORT,
  MARSHAL_SUPPORT: DAILY_SPECIAL_SUPPORT_KIND_BADGES.MARSHAL_SUPPORT,
  LEADER_SUPPORT: DAILY_SPECIAL_SUPPORT_KIND_BADGES.LEADER_SUPPORT,
  FIFTY_FOUR_SUPPORT: DAILY_SPECIAL_SUPPORT_KIND_BADGES.FIFTY_FOUR_SUPPORT,
};

const SUPPORT_PATTERN_TAG: Partial<Record<DailySpecialSupportWorkPattern, string>> =
  {
    ONE_TWO: "1·2",
    FIFTY_FOUR: "54",
  };

export function boardExportXlsxFilename(date: string): string {
  return `VERTHILL_배치표_${date}.xlsx`;
}

/** 서버 응답용. 클라이언트 <a download>와 같은 파일명을 RFC5987로 인코딩한다. */
export function boardExportXlsxContentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7E]/g, "_");
  const encoded = encodeURIComponent(filename).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export function boardExcelAssignmentTags(row: AutoAssignmentRow): string[] {
  const tags: string[] = [];
  const linked = LINKED_KIND_TAG[row.kind];
  if (linked) tags.push(linked);

  const rawKind = row.supportKind || row.caddy?.supportKind;
  const rawPattern = row.supportWorkPattern || row.caddy?.supportWorkPattern;
  const parsedKind = parseSupportKindInput(rawKind);
  const parsedPattern = parseSupportWorkPatternInput(rawPattern);

  if (row.kind === "specialSupport") {
    tags.push(parsedKind ? SUPPORT_KIND_TAG[parsedKind] : "지원");
  } else if (parsedKind && parsedKind !== "SPECIAL_SUPPORT") {
    tags.push(SUPPORT_KIND_TAG[parsedKind]);
  }

  if (parsedPattern) {
    const pat = SUPPORT_PATTERN_TAG[parsedPattern];
    if (pat) tags.push(pat);
  }

  const seen = new Set<string>();
  const unique: string[] = [];
  for (const tag of tags) {
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    unique.push(tag);
  }
  return unique;
}

function isVacantCaddy(row: AutoAssignmentRow): boolean {
  const caddy = row.caddy;
  if (!caddy) return true;
  if (!Number.isInteger(caddy.id) || caddy.id <= 0) return true;
  return String(caddy.name || "").trim() === "";
}

export function boardExcelAssignmentText(row: AutoAssignmentRow): string {
  if (isVacantCaddy(row)) return "";
  const name = String(row.caddy?.name ?? "").trim();
  if (!name) return "";
  const tags = boardExcelAssignmentTags(row);
  if (tags.length === 0) return name;
  return `${name} [${tags.join("·")}]`;
}

export function boardExcelCellText(rows: readonly AutoAssignmentRow[]): string {
  return rows
    .map((row) => boardExcelAssignmentText(row))
    .filter((text) => text !== "")
    .join("\n");
}

function sliceToAoa(slice: BoardExportSlice): unknown[][] {
  const aoa: unknown[][] = [
    [BOARD_XLSX_TITLE],
    [`날짜: ${slice.date}`],
    [`부: ${slice.shift}`],
    [],
    [...BOARD_XLSX_TABLE_HEADERS],
  ];
  for (const timeRow of slice.rows) {
    const line: unknown[] = [timeRow.teeTime];
    for (const code of COURSE_CODES) {
      const cell = timeRow.cells[code];
      if (cell.kind === "assigned") {
        line.push(boardExcelCellText(cell.rows));
      } else {
        line.push("");
      }
    }
    aoa.push(line);
  }
  return aoa;
}

function applySheetLayout(ws: XLSX.WorkSheet, dataRowCount: number) {
  ws["!cols"] = [
    { wch: 10 },
    { wch: 18 },
    { wch: 18 },
    { wch: 18 },
    { wch: 18 },
  ];
  const rows: XLSX.RowInfo[] = [
    { hpt: 22 },
    { hpt: 18 },
    { hpt: 18 },
    { hpt: 8 },
    { hpt: 20 },
  ];
  for (let i = 0; i < dataRowCount; i++) {
    rows.push({ hpt: 22 });
  }
  ws["!rows"] = rows;
  ws["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 4 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: 4 } },
    { s: { r: 2, c: 0 }, e: { r: 2, c: 4 } },
  ];
  ws["!margins"] = {
    left: 0.25,
    right: 0.25,
    top: 0.4,
    bottom: 0.4,
    header: 0.2,
    footer: 0.2,
  };
  delete ws["!protect"];
}

export function buildBoardExportWorkbook(draft: AssignmentDraft): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();
  wb.Props = {
    Title: BOARD_XLSX_TITLE,
    Subject: `날짜: ${draft.date}`,
  };
  for (const shift of BOARD_EXPORT_SHIFTS) {
    const slice = buildBoardExportSlice(draft, shift);
    const aoa = sliceToAoa(slice);
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    applySheetLayout(ws, slice.rows.length);
    XLSX.utils.book_append_sheet(wb, ws, shift);
  }
  return wb;
}

function toUint8Array(out: unknown): Uint8Array {
  if (out instanceof Uint8Array) return out;
  if (typeof ArrayBuffer !== "undefined" && out instanceof ArrayBuffer) {
    return new Uint8Array(out);
  }
  if (Array.isArray(out)) return Uint8Array.from(out as number[]);
  if (
    typeof Buffer !== "undefined" &&
    typeof Buffer.isBuffer === "function" &&
    Buffer.isBuffer(out)
  ) {
    return new Uint8Array(out);
  }
  throw new Error("xlsx 버퍼를 만들지 못했습니다.");
}

export function writeBoardExportXlsxBytes(draft: AssignmentDraft): Uint8Array {
  const wb = buildBoardExportWorkbook(draft);
  const out = XLSX.write(wb, {
    bookType: "xlsx",
    type: "array",
    compression: true,
    cellDates: false,
  });
  return toUint8Array(out);
}

export type ParsedBoardExcelRow = {
  teeTime: string;
  values: Record<CourseCode, string>;
};

export type ParsedBoardExcelSheet = {
  name: string;
  title: string;
  dateLine: string;
  shiftLine: string;
  headers: string[];
  rows: ParsedBoardExcelRow[];
};

function cellString(value: unknown): string {
  if (value == null) return "";
  return String(value);
}

export function parseBoardExportWorkbook(
  data: Uint8Array | ArrayBuffer | Buffer
): ParsedBoardExcelSheet[] {
  const buf =
    data instanceof Uint8Array
      ? Buffer.from(data)
      : Buffer.from(new Uint8Array(data as ArrayBuffer));
  const wb = XLSX.read(buf, { type: "buffer", raw: false });
  return wb.SheetNames.map((name) => {
    const ws = wb.Sheets[name];
    const aoa = XLSX.utils.sheet_to_json<(string | number | null)[]>(ws, {
      header: 1,
      raw: false,
      defval: "",
    });
    const title = cellString(aoa[0]?.[0]);
    const dateLine = cellString(aoa[1]?.[0]);
    const shiftLine = cellString(aoa[2]?.[0]);
    const headers = (aoa[BOARD_XLSX_HEADER_ROW] || []).map((v) => cellString(v));
    const rows: ParsedBoardExcelRow[] = [];
    for (let i = BOARD_XLSX_DATA_START_ROW; i < aoa.length; i++) {
      const line = aoa[i] || [];
      const teeTime = cellString(line[0]).trim();
      if (!teeTime) continue;
      const values = {} as Record<CourseCode, string>;
      COURSE_CODES.forEach((code, idx) => {
        values[code] = cellString(line[idx + 1]);
      });
      rows.push({ teeTime, values });
    }
    return { name, title, dateLine, shiftLine, headers, rows };
  });
}

export function countAssignedExcelCells(sheets: ParsedBoardExcelSheet[]): {
  total: number;
  byShift: Record<ShiftPart, number>;
} {
  const byShift = { "1부": 0, "2부": 0, "3부": 0 } as Record<ShiftPart, number>;
  let total = 0;
  for (const sheet of sheets) {
    const shift = sheet.name as ShiftPart;
    let n = 0;
    for (const row of sheet.rows) {
      for (const code of COURSE_CODES) {
        if (String(row.values[code] || "").trim() !== "") n += 1;
      }
    }
    if (shift in byShift) byShift[shift] = n;
    total += n;
  }
  return { total, byShift };
}

export function downloadBoardXlsxBytes(
  bytes: Uint8Array,
  filename: string,
  opts?: { revokeMs?: number }
) {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const blob = new Blob([copy], { type: BOARD_XLSX_MIME });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), opts?.revokeMs ?? 8000);
}
