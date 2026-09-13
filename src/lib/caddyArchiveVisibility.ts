/**
 * 캐디관리 보관(퇴사/삭제) 조회 권한.
 * 운영계 제외는 operationalRoster를 재사용한다. 여기서 재구현하지 않는다.
 *
 * Admin(최고관리자 / env-only admin)만 보관 조회.
 * 경기과 직원 admin·caddy/staff·leader는 목록/검색/상세에서 보관 캐디를 읽지 못한다.
 */

import { isOperationalEmploymentStatus } from "@/lib/operationalRoster";
import { isAccountManagerAuth } from "@/lib/staffAdminAccounts";

export type ArchiveAuthInput = {
  role?: string | null;
  username?: string | null;
  userId?: number | null;
  uid?: number | null;
};

export function canReadArchivedCaddies(
  auth: ArchiveAuthInput | null | undefined
): boolean {
  if (!auth) return false;
  return isAccountManagerAuth(auth);
}

export function isArchivedEmploymentStatus(value: unknown): boolean {
  return !isOperationalEmploymentStatus(value);
}

export function denyArchivedCaddyRead(
  employmentStatus: unknown,
  canReadArchived: boolean
): boolean {
  return !canReadArchived && isArchivedEmploymentStatus(employmentStatus);
}

export type CaddyManageListWhere =
  | { empty: true }
  | { employmentStatus: "ACTIVE" | "LEAVE" | "RETIRED" }
  | { employmentStatus: { in: Array<"ACTIVE" | "LEAVE"> } }
  | Record<string, never>;

export function caddyManageListWhere(
  filter: "all" | "ACTIVE" | "LEAVE" | "RETIRED",
  canReadArchived: boolean
): CaddyManageListWhere {
  if (!canReadArchived) {
    if (filter === "RETIRED") return { empty: true };
    if (filter === "all") {
      return { employmentStatus: { in: ["ACTIVE", "LEAVE"] } };
    }
    if (filter === "LEAVE") return { employmentStatus: "LEAVE" };
    return { employmentStatus: "ACTIVE" };
  }
  if (filter === "all") return {};
  return { employmentStatus: filter };
}

export function filterArchivedCaddies<T extends { employmentStatus?: unknown }>(
  rows: readonly T[],
  canReadArchived: boolean
): T[] {
  if (canReadArchived) return [...rows];
  return rows.filter((row) => !isArchivedEmploymentStatus(row.employmentStatus));
}
