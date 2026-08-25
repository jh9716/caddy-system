/**
 * 운영 UI 캐디 표시명. API/DB id·teamOrder는 받지 않고 쓰지 않는다.
 * 동명이인 구분은 호출측 disambiguator만 사용 (DB id 금지).
 */
import { DRIVING_POOL_TEAM, isDrivingCaddyType } from "@/lib/caddyManage";

export type CaddyLabelInput = {
  name?: string | null;
  team?: string | null;
  caddyType?: string | null;
};

export function caddyAffiliation(caddy: CaddyLabelInput): string {
  if (isDrivingCaddyType(caddy.caddyType)) return DRIVING_POOL_TEAM;
  const team = String(caddy.team ?? "").trim();
  if (team === DRIVING_POOL_TEAM) return DRIVING_POOL_TEAM;
  return team;
}

export function formatCaddyLabel(
  caddy: CaddyLabelInput,
  opts?: { disambiguator?: string }
): string {
  const name = String(caddy.name ?? "").trim() || "이름없음";
  const affiliation = caddyAffiliation(caddy);
  const base = affiliation ? `${affiliation} ${name}` : name;
  const extra = String(opts?.disambiguator ?? "").trim();
  return extra ? `${base} ${extra}` : base;
}
