/**
 * 운영 휴무 Google Sheet 읽기 (htmlview/export, 쓰기 없음)
 */

import * as XLSX from "xlsx";
import {
  offNamesForDate,
  type OffSheet,
} from "@/lib/offSheetParser";

export const DEFAULT_OFF_SHEET_ID = "1KIYkXrNQi004qkkyFWRYQqVxPkpi87EwcbDzIOUfRIw";

export class OffSheetError extends Error {
  status = 502;
  code = "off_sheet_error";
  constructor(message: string, code?: string, status?: number) {
    super(message);
    this.name = "OffSheetError";
    if (code) this.code = code;
    if (status) this.status = status;
  }
}

function sheetId(): string {
  return (
    process.env.OFF_SHEET_ID?.trim() ||
    DEFAULT_OFF_SHEET_ID
  );
}

function exportUrl(id: string): string {
  return `https://docs.google.com/spreadsheets/d/${id}/export?format=xlsx`;
}

export function workbookToOffSheets(buffer: Buffer): OffSheet[] {
  const workbook = XLSX.read(buffer, {
    type: "buffer",
    cellDates: true,
    raw: true,
  });
  return workbook.SheetNames.map((name) => {
    const sheet = workbook.Sheets[name];
    const ref = sheet?.["!ref"];
    const matrix: unknown[][] = [];
    if (ref) {
      const range = XLSX.utils.decode_range(ref);
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
    }
    return { name, matrix };
  });
}

export async function fetchPublishedOffSheets(): Promise<OffSheet[]> {
  const id = sheetId();
  const url = exportUrl(id);
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": "caddy-system-off-sheet/1.0" },
      redirect: "follow",
      cache: "no-store",
    });
  } catch (e) {
    throw new OffSheetError(
      `휴무 Google Sheet에 연결하지 못했습니다. (${e instanceof Error ? e.message : "network"})`,
      "off_sheet_fetch_failed",
      502
    );
  }
  if (!res.ok) {
    throw new OffSheetError(
      `휴무 Google Sheet를 읽지 못했습니다. (HTTP ${res.status}) 공개 htmlview/내보내기 권한을 확인해주세요.`,
      "off_sheet_fetch_failed",
      502
    );
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 32) {
    throw new OffSheetError(
      "휴무 Google Sheet 응답이 비어 있습니다.",
      "off_sheet_empty",
      502
    );
  }
  try {
    const sheets = workbookToOffSheets(buf);
    if (sheets.length === 0) {
      throw new OffSheetError(
        "휴무 Google Sheet에 시트가 없습니다.",
        "off_sheet_empty",
        502
      );
    }
    return sheets;
  } catch (e) {
    if (e instanceof OffSheetError) throw e;
    throw new OffSheetError(
      `휴무 Google Sheet 형식을 해석하지 못했습니다. (${e instanceof Error ? e.message : "parse"})`,
      "off_sheet_parse_failed",
      502
    );
  }
}

export function requireOffNamesForDate(
  sheets: readonly OffSheet[],
  ymd: string
): string[] {
  const { names, matchedSheetDates } = offNamesForDate(sheets, ymd);
  if (!matchedSheetDates.includes(ymd)) {
    throw new OffSheetError(
      `선택한 날짜 ${ymd}의 휴무 칸을 스프레드시트에서 찾지 못했습니다. 기간 탭(예: 0817~30)에 해당 일자가 있는지 확인해주세요.`,
      "off_sheet_date_not_found",
      400
    );
  }
  return names;
}
