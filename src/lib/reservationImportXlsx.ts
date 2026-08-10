/**
 * 예약표 XLSX/XLS → 표준 ReservationParseResult
 * SheetJS 사용. DB 쓰기 없음.
 */

import * as XLSX from "xlsx";
import {
  cellText,
  parseReservationSheets,
  type ReservationParseResult,
} from "@/lib/reservationParser";

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
      // Prefer raw typed value for dates/times (serials)
      if (cell.t === "n" && typeof cell.v === "number") {
        row.push(cell.v);
      } else if (cell.t === "d" && cell.v instanceof Date) {
        row.push(cell.v);
      } else {
        row.push(cell.v ?? cellText(cell.w));
      }
    }
    matrix.push(row);
  }
  return matrix;
}

export function parseReservationWorkbook(
  buffer: Buffer | ArrayBuffer | Uint8Array,
  options?: { filename?: string; defaultDate?: string | null }
): ReservationParseResult {
  const data =
    buffer instanceof Buffer
      ? buffer
      : Buffer.from(buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer);

  const workbook = XLSX.read(data, {
    type: "buffer",
    cellDates: true,
    raw: true,
  });

  const sheets = workbook.SheetNames.map((name) => ({
    name,
    matrix: sheetToMatrix(workbook.Sheets[name]),
  }));

  // filename date hint e.g. 예약_2026-08-10.xlsx
  let defaultDate = options?.defaultDate ?? null;
  if (!defaultDate && options?.filename) {
    const m = options.filename.match(/(\d{4})[-_.]?(\d{2})[-_.]?(\d{2})/);
    if (m) defaultDate = `${m[1]}-${m[2]}-${m[3]}`;
  }

  return parseReservationSheets(sheets, { defaultDate });
}

/** 테스트용: AOA 시트들로 xlsx 버퍼 생성 */
export function buildTestReservationXlsxBuffer(
  sheets: Array<{ name: string; aoa: unknown[][] }>
): Buffer {
  const wb = XLSX.utils.book_new();
  for (const sheet of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(sheet.aoa);
    XLSX.utils.book_append_sheet(wb, ws, sheet.name.slice(0, 31));
  }
  return Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
}
