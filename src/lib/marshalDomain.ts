/**
 * 마샬 명단 도메인 — 순수 함수 (DB I/O 없음).
 * 월 자동배정 / DailyOpsDuty 투영 / Assignment.MARSHAL 은 여기 없다.
 */

export const MARSHAL_PROFILE_ENTITY = "MarshalProfile";

export const MARSHAL_AUDIT_ACTIONS = {
  CREATE: "MARSHAL_PROFILE_CREATE",
  DEACTIVATE: "MARSHAL_PROFILE_DEACTIVATE",
  REACTIVATE: "MARSHAL_PROFILE_REACTIVATE",
  UPDATE_STARTED_ON: "MARSHAL_PROFILE_UPDATE_STARTED_ON",
} as const;

export type MarshalAuditAction =
  (typeof MARSHAL_AUDIT_ACTIONS)[keyof typeof MARSHAL_AUDIT_ACTIONS];

export const CADDY_TYPE_LABELS: Record<string, string> = {
  HOUSE: "하우스",
  THIRD: "3부반",
  DRIVING: "드라이빙",
};

export function caddyTypeLabel(value: unknown): string {
  const key = String(value ?? "").trim().toUpperCase();
  return CADDY_TYPE_LABELS[key] || key || "—";
}

export type MarshalRosterCaddy = {
  id: number;
  name: string;
  team: string;
  teamOrder: number;
  caddyType: string;
  employmentStatus: string;
};

export type MarshalRosterRow = {
  id: number;
  caddyId: number;
  active: boolean;
  startedOn: string;
  caddy: MarshalRosterCaddy;
  createdAt: string;
  updatedAt: string;
};

export class MarshalRosterError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = "MarshalRosterError";
    this.code = code;
    this.status = status;
  }
}

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isMarshalYmd(value: unknown): value is string {
  return typeof value === "string" && YMD_RE.test(value);
}

/** YYYY-MM-DD → 로컬 자정. overflow(2월 30일) 거부. */
export function parseMarshalStartedOn(value: unknown): Date {
  const ymd = String(value ?? "").trim();
  if (!isMarshalYmd(ymd)) {
    throw new MarshalRosterError(
      "마샬 시작일은 YYYY-MM-DD 이어야 합니다.",
      "invalid_started_on",
      400
    );
  }
  const date = new Date(`${ymd}T00:00:00`);
  if (Number.isNaN(date.getTime())) {
    throw new MarshalRosterError(
      "마샬 시작일이 올바르지 않습니다.",
      "invalid_started_on",
      400
    );
  }
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  if (`${y}-${m}-${d}` !== ymd) {
    throw new MarshalRosterError(
      "마샬 시작일이 올바르지 않습니다.",
      "invalid_started_on",
      400
    );
  }
  return date;
}

export function formatMarshalYmd(value: Date | string): string {
  if (typeof value === "string" && isMarshalYmd(value.slice(0, 10))) {
    return value.slice(0, 10);
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new MarshalRosterError(
      "마샬 시작일이 올바르지 않습니다.",
      "invalid_started_on",
      400
    );
  }
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function parsePositiveId(value: unknown, field = "id"): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new MarshalRosterError(`${field}가 필요합니다.`, `${field}_required`, 400);
  }
  return n;
}

export function parsePositiveCaddyId(value: unknown): number {
  return parsePositiveId(value, "caddyId");
}

export function assertCaddyEligibleForMarshal(caddy: {
  id?: number;
  name?: string;
  employmentStatus?: string | null;
} | null): asserts caddy is { id: number; name: string; employmentStatus: string } {
  if (!caddy || !Number.isInteger(caddy.id) || (caddy.id as number) < 1) {
    throw new MarshalRosterError(
      "존재하지 않는 캐디입니다.",
      "caddy_not_found",
      404
    );
  }
  if (caddy.employmentStatus !== "ACTIVE") {
    const name = String(caddy.name || "").trim() || String(caddy.id);
    throw new MarshalRosterError(
      `RETIRED/LEAVE 캐디는 마샬 명단에 등록하지 않습니다: ${name}(${caddy.employmentStatus})`,
      "inactive_caddy",
      400
    );
  }
}

export function serializeMarshalProfile(row: {
  id: number;
  caddyId: number;
  active: boolean;
  startedOn: Date | string;
  createdAt: Date | string;
  updatedAt: Date | string;
  caddy: MarshalRosterCaddy;
}): MarshalRosterRow {
  return {
    id: row.id,
    caddyId: row.caddyId,
    active: row.active,
    startedOn: formatMarshalYmd(row.startedOn),
    caddy: {
      id: row.caddy.id,
      name: row.caddy.name,
      team: row.caddy.team,
      teamOrder: row.caddy.teamOrder,
      caddyType: row.caddy.caddyType,
      employmentStatus: row.caddy.employmentStatus,
    },
    createdAt:
      row.createdAt instanceof Date
        ? row.createdAt.toISOString()
        : String(row.createdAt),
    updatedAt:
      row.updatedAt instanceof Date
        ? row.updatedAt.toISOString()
        : String(row.updatedAt),
  };
}
