/**
 * /manage/assignments date query. Calendar-valid YYYY-MM-DD only.
 * Never writes an absolute/external URL.
 */

import { parseAssignmentYmd } from "@/lib/legacyAssignmentApi";

export const ASSIGNMENTS_DATE_PARAM = "date";
export const ASSIGNMENTS_OPS_PATH = "/manage/assignments";

export function parseAssignmentsDateParam(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return parseAssignmentYmd(value.trim())?.ymd ?? null;
}

export function assignmentsDateFromSearch(
  search: string | URLSearchParams | null | undefined
): string | null {
  if (!search) return null;
  const params =
    typeof search === "string"
      ? new URLSearchParams(search.startsWith("?") ? search.slice(1) : search)
      : search;
  return parseAssignmentsDateParam(params.get(ASSIGNMENTS_DATE_PARAM));
}

export function isAssignmentsOpsPath(pathname: string): boolean {
  return pathname === ASSIGNMENTS_OPS_PATH || pathname === `${ASSIGNMENTS_OPS_PATH}/`;
}

function normalizeSearch(search: string): string {
  if (!search) return "";
  return search.startsWith("?") ? search : `?${search}`;
}

export function buildAssignmentsSearch(input: {
  currentSearch?: string;
  date: string;
}): string {
  const raw = input.currentSearch || "";
  const params = new URLSearchParams(
    raw.startsWith("?") ? raw.slice(1) : raw
  );
  const ymd = parseAssignmentsDateParam(input.date);
  if (ymd) params.set(ASSIGNMENTS_DATE_PARAM, ymd);
  else params.delete(ASSIGNMENTS_DATE_PARAM);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export function replaceAssignmentsDateUrl(input: {
  pathname: string;
  search: string;
  hash?: string;
  date: string;
  replaceState?: (url: string) => void;
}): string | null {
  if (!isAssignmentsOpsPath(input.pathname)) return null;
  const nextSearch = buildAssignmentsSearch({
    currentSearch: input.search,
    date: input.date,
  });
  const hash = input.hash && input.hash.startsWith("#") ? input.hash : "";
  const next = `${ASSIGNMENTS_OPS_PATH}${nextSearch}${hash}`;
  const current = `${ASSIGNMENTS_OPS_PATH}${normalizeSearch(input.search)}${hash}`;
  if (next === current) return next;
  input.replaceState?.(next);
  return next;
}
