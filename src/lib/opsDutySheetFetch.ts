/**
 * 당번·마샬·조장 Google Spreadsheet 읽기 (xlsx export, 쓰기 없음)
 * persist / quick-mutation 경로에서 호출하지 말 것.
 */

import * as XLSX from "xlsx";
import { isLocalDatabaseUrl } from "@/lib/dbSafety";
import {
  OpsDutySheetError,
  type OpsDutySheet,
} from "@/lib/opsDutySheetParser";

export const DEFAULT_OPS_DUTY_SHEET_ID =
  "1xMG0jnWsDpH2HXlj53Qx-txOyycz1mIS-MyRlX35uJI";

export const OPS_DUTY_SHEET_CACHE_MS = 45_000;

export { OpsDutySheetError };

function sheetId(): string {
  return process.env.OPS_DUTY_SHEET_ID?.trim() || DEFAULT_OPS_DUTY_SHEET_ID;
}

function exportUrl(id: string): string {
  return `https://docs.google.com/spreadsheets/d/${id}/export?format=xlsx`;
}

export function workbookToOpsDutySheets(buffer: Buffer): OpsDutySheet[] {
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

let opsDutySheetCache: { id: string; at: number; sheets: OpsDutySheet[] } | null =
  null;
let opsDutySheetCacheGeneration = 0;
const workbookInflight = new Map<string, Promise<OpsDutySheet[]>>();
let opsDutySheetHttpFetchCount = 0;
let testOpsDutySheetLoader: ((
  opts?: { force?: boolean; signal?: AbortSignal }
) => Promise<OpsDutySheet[]>) | null = null;

export function invalidateOpsDutySheetCache() {
  opsDutySheetCacheGeneration += 1;
  opsDutySheetCache = null;
  workbookInflight.clear();
}

export function getOpsDutySheetHttpFetchCount(): number {
  return opsDutySheetHttpFetchCount;
}

export function resetOpsDutySheetHttpStatsForTests() {
  if (process.env.NODE_ENV === "production") return;
  opsDutySheetHttpFetchCount = 0;
  workbookInflight.clear();
}

export function setPublishedOpsDutySheetLoaderForTests(
  loader: ((
    opts?: { force?: boolean; signal?: AbortSignal }
  ) => Promise<OpsDutySheet[]>) | null
) {
  if (process.env.NODE_ENV === "production") return;
  testOpsDutySheetLoader = loader;
}

export function seedOpsDutySheetCacheForTests(sheets: OpsDutySheet[]) {
  if (process.env.NODE_ENV === "production") return;
  opsDutySheetCache = { id: sheetId(), at: Date.now(), sheets };
}

export function peekCachedOpsDutySheets(): OpsDutySheet[] | null {
  const id = sheetId();
  const now = Date.now();
  if (
    opsDutySheetCache &&
    opsDutySheetCache.id === id &&
    now - opsDutySheetCache.at < OPS_DUTY_SHEET_CACHE_MS
  ) {
    return opsDutySheetCache.sheets;
  }
  return null;
}

function allowLocalOpsDutySheetTestHooks(): boolean {
  return (
    process.env.NODE_ENV !== "production" &&
    isLocalDatabaseUrl(process.env.DATABASE_URL)
  );
}

function abortError(): Error {
  const error = new Error("ops-duty-sheet-timeout");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = String((error as { name?: unknown }).name || "");
  const message = String((error as { message?: unknown }).message || "");
  return (
    name === "AbortError" ||
    name === "TimeoutError" ||
    /aborted|abort|ops-duty-sheet-timeout/i.test(message)
  );
}

function rejectWhenAborted<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

async function loadPublishedOpsDutySheetsUncached(opts?: {
  force?: boolean;
  timeoutMs?: number;
}): Promise<OpsDutySheet[]> {
  const id = sheetId();
  const generation = opsDutySheetCacheGeneration;
  const commitCache = (sheets: OpsDutySheet[]) => {
    if (generation !== opsDutySheetCacheGeneration) return;
    opsDutySheetCache = { id, at: Date.now(), sheets };
  };
  const controller = new AbortController();
  const timeoutMs = Number(opts?.timeoutMs || 0);
  const timer =
    timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
  const signal = controller.signal;
  try {
    if (signal.aborted) throw abortError();
    if (testOpsDutySheetLoader) {
      opsDutySheetHttpFetchCount += 1;
      const sheets = await rejectWhenAborted(
        signal,
        testOpsDutySheetLoader({ force: opts?.force, signal })
      );
      if (!sheets.length) {
        throw new OpsDutySheetError(
          "운영배치 Google Sheet에 시트가 없습니다.",
          "ops_duty_sheet_empty",
          502
        );
      }
      commitCache(sheets);
      return sheets;
    }
    const testFile = process.env.OPS_DUTY_SHEET_TEST_FILE?.trim();
    if (testFile && allowLocalOpsDutySheetTestHooks()) {
      opsDutySheetHttpFetchCount += 1;
      const { readFileSync } = await import("node:fs");
      const sheets = JSON.parse(readFileSync(testFile, "utf8")) as OpsDutySheet[];
      if (!Array.isArray(sheets) || sheets.length === 0) {
        throw new OpsDutySheetError(
          "운영배치 Google Sheet에 시트가 없습니다.",
          "ops_duty_sheet_empty",
          502
        );
      }
      commitCache(sheets);
      return sheets;
    }
    const url = exportUrl(id);
    opsDutySheetHttpFetchCount += 1;
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { "User-Agent": "caddy-system-ops-duty-sheet/1.0" },
        redirect: "follow",
        cache: "no-store",
        signal,
      });
    } catch (e) {
      if (signal.aborted || isAbortError(e)) {
        throw new OpsDutySheetError(
          "운영배치 Google Sheet 요청이 시간 초과되었습니다.",
          "ops_duty_sheet_timeout",
          503
        );
      }
      throw new OpsDutySheetError(
        `운영배치 Google Sheet에 연결하지 못했습니다. (${e instanceof Error ? e.message : "network"})`,
        "ops_duty_sheet_fetch_failed",
        502
      );
    }
    if (!res.ok) {
      throw new OpsDutySheetError(
        `운영배치 Google Sheet를 읽지 못했습니다. (HTTP ${res.status}) 공개 내보내기 권한을 확인해주세요.`,
        "ops_duty_sheet_fetch_failed",
        502
      );
    }
    const buf = Buffer.from(await rejectWhenAborted(signal, res.arrayBuffer()));
    if (buf.length < 32) {
      throw new OpsDutySheetError(
        "운영배치 Google Sheet 응답이 비어 있습니다.",
        "ops_duty_sheet_empty",
        502
      );
    }
    try {
      const sheets = workbookToOpsDutySheets(buf);
      if (sheets.length === 0) {
        throw new OpsDutySheetError(
          "운영배치 Google Sheet에 시트가 없습니다.",
          "ops_duty_sheet_empty",
          502
        );
      }
      commitCache(sheets);
      return sheets;
    } catch (e) {
      if (e instanceof OpsDutySheetError) throw e;
      throw new OpsDutySheetError(
        `운영배치 Google Sheet 형식을 해석하지 못했습니다. (${e instanceof Error ? e.message : "parse"})`,
        "ops_duty_sheet_parse_failed",
        502
      );
    }
  } catch (e) {
    if (signal.aborted || isAbortError(e)) {
      throw new OpsDutySheetError(
        "운영배치 Google Sheet 요청이 시간 초과되었습니다.",
        "ops_duty_sheet_timeout",
        503
      );
    }
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function fetchPublishedOpsDutySheets(opts?: {
  force?: boolean;
  timeoutMs?: number;
}): Promise<OpsDutySheet[]> {
  const id = sheetId();
  const cached = peekCachedOpsDutySheets();
  if (!opts?.force && cached) {
    return cached;
  }
  const existing = workbookInflight.get(id);
  if (existing) return existing;
  const pending = loadPublishedOpsDutySheetsUncached(opts).finally(() => {
    if (workbookInflight.get(id) === pending) workbookInflight.delete(id);
  });
  workbookInflight.set(id, pending);
  return pending.catch((error) => {
    if (workbookInflight.get(id) === pending) workbookInflight.delete(id);
    throw error;
  });
}
