/**
 * 운영 휴무 Google Sheet 읽기 (htmlview/export, 쓰기 없음)
 */

import * as XLSX from "xlsx";
import {
  offNamesForDate,
  type OffSheet,
} from "@/lib/offSheetParser";
import { isLocalDatabaseUrl } from "@/lib/dbSafety";

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

export const OFF_SHEET_CACHE_MS = 45_000;

type OffDateSnapshot = {
  ymd: string;
  matched: boolean;
  names: string[];
  at: number;
};

let offSheetCache: { id: string; at: number; sheets: OffSheet[] } | null = null;
let offSheetCacheGeneration = 0;
const offDateSnapshots = new Map<string, OffDateSnapshot>();
const workbookInflight = new Map<string, Promise<OffSheet[]>>();
let offSheetHttpFetchCount = 0;
let testOffSheetLoader: ((
  opts?: { force?: boolean; signal?: AbortSignal }
) => Promise<OffSheet[]>) | null = null;

export function invalidateOffSheetCache() {
  offSheetCacheGeneration += 1;
  offSheetCache = null;
  offDateSnapshots.clear();
  workbookInflight.clear();
}

export function getOffSheetHttpFetchCount(): number {
  return offSheetHttpFetchCount;
}

export function resetOffSheetHttpStatsForTests() {
  if (process.env.NODE_ENV === "production") return;
  offSheetHttpFetchCount = 0;
  workbookInflight.clear();
}

export function setPublishedOffSheetLoaderForTests(
  loader: ((
    opts?: { force?: boolean; signal?: AbortSignal }
  ) => Promise<OffSheet[]>) | null
) {
  if (process.env.NODE_ENV === "production") return;
  testOffSheetLoader = loader;
}

export function peekWorkbookInflightCountForTests(): number {
  if (process.env.NODE_ENV === "production") return 0;
  return workbookInflight.size;
}

export function isOffSheetAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = String((error as { name?: unknown }).name || "");
  const message = String((error as { message?: unknown }).message || "");
  return (
    name === "AbortError" ||
    name === "TimeoutError" ||
    /aborted|abort|off-sheet-timeout/i.test(message)
  );
}

/** Process cache only. Not date-safe by itself. */
export function peekCachedOffSheets(): OffSheet[] | null {
  const id = sheetId();
  const now = Date.now();
  if (
    offSheetCache &&
    offSheetCache.id === id &&
    now - offSheetCache.at < OFF_SHEET_CACHE_MS
  ) {
    return offSheetCache.sheets;
  }
  return null;
}

/** Cache hit only when this ymd exists in the cached workbook. */
export function peekCachedOffSheetsForDate(ymd: string): OffSheet[] | null {
  const sheets = peekCachedOffSheets();
  if (!sheets) return null;
  try {
    const parsed = offNamesForDate(sheets, ymd);
    if (!parsed.matchedSheetDates.includes(ymd)) return null;
    return sheets;
  } catch {
    return null;
  }
}

export function seedOffSheetCacheForTests(sheets: OffSheet[]) {
  if (process.env.NODE_ENV === "production") return;
  offSheetCache = { id: sheetId(), at: Date.now(), sheets };
  offDateSnapshots.clear();
}

export function peekOffDateSnapshot(ymd: string): OffDateSnapshot | null {
  const snap = offDateSnapshots.get(ymd);
  if (!snap) return null;
  if (Date.now() - snap.at >= OFF_SHEET_CACHE_MS) {
    offDateSnapshots.delete(ymd);
    return null;
  }
  return snap;
}

export function rememberOffSheetsForDate(ymd: string, sheets: OffSheet[]) {
  offSheetCache = { id: sheetId(), at: Date.now(), sheets };
  try {
    const parsed = offNamesForDate(sheets, ymd);
    const matched = parsed.matchedSheetDates.includes(ymd);
    if (!matched) {
      offDateSnapshots.delete(ymd);
      return;
    }
    offDateSnapshots.set(ymd, {
      ymd,
      matched: true,
      names: parsed.names,
      at: Date.now(),
    });
  } catch {
    offDateSnapshots.delete(ymd);
  }
}

function allowLocalOffSheetTestHooks(): boolean {
  return (
    process.env.NODE_ENV !== "production" &&
    isLocalDatabaseUrl(process.env.DATABASE_URL)
  );
}

async function applyLocalOffSheetTestDelay() {
  if (!allowLocalOffSheetTestHooks()) return;
  const delay = Number(process.env.OFF_SHEET_TEST_DELAY_MS || 0);
  if (!Number.isFinite(delay) || delay <= 0) return;
  await new Promise((resolve) =>
    setTimeout(resolve, Math.min(Math.floor(delay), 10_000))
  );
}

function abortError(): Error {
  const error = new Error("off-sheet-timeout");
  error.name = "AbortError";
  return error;
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

async function loadPublishedOffSheetsUncached(opts?: {
  force?: boolean;
  timeoutMs?: number;
}): Promise<OffSheet[]> {
  const id = sheetId();
  const generation = offSheetCacheGeneration;
  const commitCache = (sheets: OffSheet[]) => {
    if (generation !== offSheetCacheGeneration) return;
    offSheetCache = { id, at: Date.now(), sheets };
  };
  const controller = new AbortController();
  const timeoutMs = Number(opts?.timeoutMs || 0);
  const timer =
    timeoutMs > 0
      ? setTimeout(() => controller.abort(), timeoutMs)
      : undefined;
  const signal = controller.signal;
  try {
    await applyLocalOffSheetTestDelay();
    if (signal.aborted) throw abortError();
    if (testOffSheetLoader) {
      offSheetHttpFetchCount += 1;
      const sheets = await rejectWhenAborted(
        signal,
        testOffSheetLoader({ force: opts?.force, signal })
      );
      if (!sheets.length) {
        throw new OffSheetError(
          "휴무 Google Sheet에 시트가 없습니다.",
          "off_sheet_empty",
          502
        );
      }
      commitCache(sheets);
      return sheets;
    }
    const testFile = process.env.OFF_SHEET_TEST_FILE?.trim();
    if (testFile && allowLocalOffSheetTestHooks()) {
      offSheetHttpFetchCount += 1;
      const { readFileSync } = await import("node:fs");
      const sheets = JSON.parse(readFileSync(testFile, "utf8")) as OffSheet[];
      if (!Array.isArray(sheets) || sheets.length === 0) {
        throw new OffSheetError(
          "휴무 Google Sheet에 시트가 없습니다.",
          "off_sheet_empty",
          502
        );
      }
      commitCache(sheets);
      return sheets;
    }
    const url = exportUrl(id);
    offSheetHttpFetchCount += 1;
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { "User-Agent": "caddy-system-off-sheet/1.0" },
        redirect: "follow",
        cache: "no-store",
        signal,
      });
    } catch (e) {
      if (signal.aborted || isOffSheetAbortError(e)) {
        throw new OffSheetError(
          "휴무 Google Sheet 요청이 시간 초과되었습니다.",
          "off_sheet_timeout",
          503
        );
      }
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
    const buf = Buffer.from(await rejectWhenAborted(signal, res.arrayBuffer()));
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
      commitCache(sheets);
      return sheets;
    } catch (e) {
      if (e instanceof OffSheetError) throw e;
      throw new OffSheetError(
        `휴무 Google Sheet 형식을 해석하지 못했습니다. (${e instanceof Error ? e.message : "parse"})`,
        "off_sheet_parse_failed",
        502
      );
    }
  } catch (e) {
    if (signal.aborted || isOffSheetAbortError(e)) {
      throw new OffSheetError(
        "휴무 Google Sheet 요청이 시간 초과되었습니다.",
        "off_sheet_timeout",
        503
      );
    }
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function fetchPublishedOffSheets(opts?: {
  force?: boolean;
  timeoutMs?: number;
}): Promise<OffSheet[]> {
  const id = sheetId();
  const cached = peekCachedOffSheets();
  if (!opts?.force && cached) {
    return cached;
  }
  const existing = workbookInflight.get(id);
  if (existing) return existing;
  const pending = loadPublishedOffSheetsUncached(opts).finally(() => {
    if (workbookInflight.get(id) === pending) workbookInflight.delete(id);
  });
  workbookInflight.set(id, pending);
  return pending.catch((error) => {
    if (workbookInflight.get(id) === pending) workbookInflight.delete(id);
    throw error;
  });
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
