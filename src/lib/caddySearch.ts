/**
 * 관리자 통합 캐디 검색 matcher.
 * phoneNormalized(010XXXXXXXX)를 canonical source로 쓴다.
 * 차량번호/알림톡 발송은 다루지 않는다.
 */

import { normalizePersonName } from "@/lib/dailyCaddyNameMatch";
import { employmentStatusLabel } from "@/lib/caddyManage";
import { maskKrMobile } from "@/lib/caddyPhone";

export type CaddySearchRecord = {
  id: number;
  name: string;
  team: string;
  caddyType?: string | null;
  employmentStatus?: string | null;
  phoneNormalized?: string | null;
};

export type CaddySearchView = {
  id: number;
  name: string;
  team: string;
  typeLabel: string;
  statusLabel: string;
  maskedPhone: string | null;
  phoneMissing: boolean;
  telHref: string | null;
};

export type SearchPlacementHit = {
  caddyId: number | null;
  shift: string;
  teeTime: string;
  course: string;
};

const PHONE_CANONICAL = /^010\d{8}$/;
const MIN_PHONE_DIGITS = 3;

export function searchDigits(query: unknown): string {
  return String(query ?? "").replace(/\D/g, "");
}

export function compactSearchText(query: unknown): string {
  return String(query ?? "")
    .replace(/\u00a0/g, " ")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

function isDigitOnlyQuery(query: string): boolean {
  const compact = compactSearchText(query);
  if (!compact) return false;
  return /^[\d\-().]+$/.test(compact);
}

function queryLooksLikePhone(query: string): boolean {
  return searchDigits(query).length >= MIN_PHONE_DIGITS;
}

export function matchesTeamQuery(team: unknown, query: string): boolean {
  const t = compactSearchText(team);
  const q = compactSearchText(query);
  if (!t || !q) return false;
  if (t === q) return true;

  const qTeam = q.replace(/조$/u, "");
  const tTeam = t.replace(/조$/u, "");
  if (/^\d{1,2}$/.test(qTeam) && /^\d{1,2}$/.test(tTeam)) {
    return qTeam === tTeam;
  }
  if (q === "조" || qTeam === "") return false;
  return t.includes(q);
}

export function matchesIdQuery(id: number, query: string): boolean {
  const raw = String(query ?? "")
    .replace(/\u00a0/g, " ")
    .trim();
  if (!raw) return false;
  if (String(id) === raw) return true;
  const digits = searchDigits(raw);
  if (!digits) return false;
  if (isDigitOnlyQuery(raw) && String(id) === digits) return true;
  return false;
}

export function matchesNameQuery(name: unknown, query: string): boolean {
  const q = normalizePersonName(query);
  if (!q) return false;
  const n = normalizePersonName(name);
  return n.includes(q);
}

export function matchesPhoneQuery(
  phoneNormalized: string | null | undefined,
  query: string
): boolean {
  if (!phoneNormalized || !PHONE_CANONICAL.test(phoneNormalized)) return false;
  if (!queryLooksLikePhone(query)) return false;
  const digits = searchDigits(query);
  return phoneNormalized.includes(digits);
}

export function matchesCaddySearch(
  caddy: CaddySearchRecord,
  query: string
): boolean {
  const raw = String(query ?? "")
    .replace(/\u00a0/g, " ")
    .trim();
  if (!raw) return false;
  return (
    matchesNameQuery(caddy.name, raw) ||
    matchesTeamQuery(caddy.team, raw) ||
    matchesIdQuery(caddy.id, raw) ||
    matchesPhoneQuery(caddy.phoneNormalized, raw)
  );
}

export function filterCaddiesBySearch<T extends CaddySearchRecord>(
  caddies: readonly T[],
  query: string
): T[] {
  const raw = String(query ?? "")
    .replace(/\u00a0/g, " ")
    .trim();
  if (!raw) return [];
  return caddies.filter((caddy) => matchesCaddySearch(caddy, raw));
}

/** tel: 링크용. invalid/null이면 링크를 만들지 않는다. */
export function caddyTelHref(
  phoneNormalized: string | null | undefined
): string | null {
  if (!phoneNormalized || !PHONE_CANONICAL.test(phoneNormalized)) return null;
  return `tel:${phoneNormalized}`;
}

export function toCaddySearchView(caddy: CaddySearchRecord): CaddySearchView {
  const telHref = caddyTelHref(caddy.phoneNormalized);
  return {
    id: caddy.id,
    name: String(caddy.name ?? "").trim() || "이름없음",
    team: String(caddy.team ?? "").trim(),
    typeLabel: String(caddy.caddyType ?? "HOUSE").trim() || "HOUSE",
    statusLabel: employmentStatusLabel(caddy.employmentStatus),
    maskedPhone: maskKrMobile(caddy.phoneNormalized),
    phoneMissing: telHref == null,
    telHref,
  };
}

export function formatShiftLabel(shift: unknown): string {
  const raw = String(shift ?? "").trim();
  if (raw === "ONE" || raw === "1" || raw === "1부") return "1부";
  if (raw === "TWO" || raw === "2" || raw === "2부") return "2부";
  if (raw === "THREE" || raw === "3" || raw === "3부") return "3부";
  return raw;
}

export function todayPlacementSummary(
  placements: readonly SearchPlacementHit[] | null | undefined,
  caddyId: number
): string | null {
  if (!placements?.length) return null;
  const hits = placements.filter((row) => row.caddyId === caddyId);
  if (!hits.length) return null;
  const parts = hits.map((row) =>
    [formatShiftLabel(row.shift), row.teeTime, row.course]
      .map((v) => String(v ?? "").trim())
      .filter(Boolean)
      .join(" ")
  );
  const unique = [...new Set(parts.filter(Boolean))];
  if (!unique.length) return "오늘 배치 있음";
  return unique.join(" · ");
}
