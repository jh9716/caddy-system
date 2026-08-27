/**
 * 날짜·부별 특수지원 저장. DailySpecialDuty / CHAGEUN 과 분리.
 * Production migrate deploy 없음.
 */

import { prisma } from "@/lib/prisma";
import { parseYmd } from "@/lib/availabilityEngine";
import { loadAvailabilityForDate } from "@/lib/availabilityService";
import type { AutoAssignCaddy } from "@/lib/autoAssignEngine";
import {
  emptySpecialSupportByShift,
  exclusionLabel,
  groupSupportRecordsByShift,
  isEligibleSpecialSupportCandidate,
  isHardExcludedSpecialSupport,
  isSpecialSupportShift,
  supportBlockedByUnavailable,
  uniqueCaddyIds,
  type SpecialSupportCandidateRow,
  type SpecialSupportRecord,
  type SpecialSupportUnavailable,
} from "@/lib/dailySpecialSupport";
import { SHIFT_PARTS, type ShiftPart } from "@/lib/reservationParser";

const caddySelect = {
  id: true,
  name: true,
  team: true,
  teamOrder: true,
  caddyType: true,
  employmentStatus: true,
  extraFlags: true,
  thirdBandSubgroup: true,
} as const;

export class DailySpecialSupportError extends Error {
  status = 400;
  code = "daily_special_support_invalid";
  constructor(message: string, code?: string, status?: number) {
    super(message);
    this.name = "DailySpecialSupportError";
    if (code) this.code = code;
    if (status) this.status = status;
  }
}

function toCaddy(row: {
  id: number;
  name: string;
  team: string;
  teamOrder: number;
  caddyType?: string | null;
  employmentStatus?: string | null;
  extraFlags?: string[] | null;
  thirdBandSubgroup?: string | null;
}): AutoAssignCaddy {
  return {
    id: row.id,
    name: row.name,
    team: row.team,
    teamOrder: Number(row.teamOrder) || 0,
    caddyType: row.caddyType ?? undefined,
    employmentStatus: row.employmentStatus ?? undefined,
    extraFlags: row.extraFlags ?? null,
    thirdBandSubgroup: row.thirdBandSubgroup ?? null,
  };
}

async function loadUnavailables(ymd: string): Promise<SpecialSupportUnavailable[]> {
  const { start } = parseYmd(ymd);
  const rows = await prisma.dailyCaddyUnavailable.findMany({
    where: { date: start },
    select: { caddyId: true, reason: true, effectiveFromShift: true },
  });
  return rows.map((row) => ({
    caddyId: row.caddyId,
    reason: row.reason,
    effectiveFromShift: row.effectiveFromShift,
  }));
}

function unavailableReasonsMap(
  rows: readonly SpecialSupportUnavailable[]
): Map<number, SpecialSupportUnavailable> {
  return new Map(rows.map((row) => [row.caddyId, row]));
}

export async function listDailySpecialSupportRecords(
  ymd: string
): Promise<SpecialSupportRecord[]> {
  parseYmd(ymd);
  const { start } = parseYmd(ymd);
  const [rows, unavailables] = await Promise.all([
    prisma.dailySpecialSupport.findMany({
      where: { date: start },
      include: { caddy: { select: caddySelect } },
      orderBy: [{ shift: "asc" }, { id: "asc" }],
    }),
    loadUnavailables(ymd),
  ]);
  const blocked = unavailableReasonsMap(unavailables);
  return rows
    .filter((row) => isSpecialSupportShift(row.shift))
    .map((row) => {
      const shift = row.shift as ShiftPart;
      const reasons: string[] = [];
      if (isHardExcludedSpecialSupport(row.caddy)) {
        reasons.push(
          row.caddy.employmentStatus === "LEAVE" ? "휴직(LEAVE)" : "퇴사(RETIRED)"
        );
      }
      const unavail = blocked.get(row.caddyId);
      const hardBlocked =
        isHardExcludedSpecialSupport(row.caddy) ||
        supportBlockedByUnavailable(unavail, shift);
      return {
        id: row.id,
        date: ymd,
        caddyId: row.caddyId,
        shift,
        name: row.caddy.name,
        team: row.caddy.team,
        teamOrder: row.caddy.teamOrder,
        excludedReasons: reasons,
        blocked: hardBlocked,
        blockedReason: hardBlocked
          ? unavail?.reason || reasons[0] || "지원 불가"
          : null,
      };
    });
}

export async function listSpecialSupportCandidates(
  ymd: string
): Promise<Array<SpecialSupportCandidateRow & { exclusionLabel: string }>> {
  const availability = await loadAvailabilityForDate(ymd);
  const unavailables = unavailableReasonsMap(await loadUnavailables(ymd));
  return availability.excluded
    .map((row) => {
      const extra = unavailables.get(row.id);
      const reasons = [...(row.excludedReasons || [])];
      if (extra?.reason === "SICK" && !reasons.some((r) => /병가/.test(r))) {
        reasons.push("병가");
      }
      if (
        extra?.reason === "ATTENDANCE_NOSHOW" &&
        !reasons.some((r) => /결근|미출근/.test(r))
      ) {
        reasons.push("결근");
      }
      const candidate: SpecialSupportCandidateRow = {
        id: row.id,
        name: row.name,
        team: row.team,
        teamOrder: row.teamOrder,
        employmentStatus: row.employmentStatus,
        excludedReasons: reasons,
        caddyType: row.caddyType,
        thirdBandSubgroup: row.thirdBandSubgroup,
        extraFlags: row.extraFlags,
      };
      return {
        ...candidate,
        exclusionLabel: exclusionLabel(reasons),
      };
    })
    .filter((row) => isEligibleSpecialSupportCandidate(row));
}

export async function buildDailySpecialSupportPayload(
  ymd: string,
  options?: { includeCandidates?: boolean }
) {
  const includeCandidates = options?.includeCandidates === true;
  const items = await listDailySpecialSupportRecords(ymd);
  const candidates = includeCandidates
    ? await listSpecialSupportCandidates(ymd)
    : [];
  return {
    date: ymd,
    items,
    byShift: groupSupportRecordsByShift(items),
    candidates,
    counts: {
      "1부": items.filter((row) => row.shift === "1부").length,
      "2부": items.filter((row) => row.shift === "2부").length,
      "3부": items.filter((row) => row.shift === "3부").length,
    },
  };
}

export async function replaceDailySpecialSupports(input: {
  date: string;
  shift: string;
  caddyIds: unknown[];
  createdByUserId?: number | null;
}): Promise<{ items: SpecialSupportRecord[]; added: number; removed: number }> {
  const ymd = input.date;
  parseYmd(ymd);
  if (!isSpecialSupportShift(input.shift)) {
    throw new DailySpecialSupportError("shift는 1부/2부/3부 이어야 합니다.");
  }
  const shift = input.shift;
  const { start } = parseYmd(ymd);
  const caddyIds = uniqueCaddyIds(input.caddyIds);
  const candidates = await listSpecialSupportCandidates(ymd);
  const eligible = new Map(candidates.map((row) => [row.id, row]));
  for (const id of caddyIds) {
    if (!eligible.has(id)) {
      throw new DailySpecialSupportError(
        "병가·결근·휴직·퇴사 캐디는 특수지원할 수 없습니다. 원래 제외된 캐디만 선택할 수 있습니다.",
        "not_eligible"
      );
    }
  }

  const existing = await prisma.dailySpecialSupport.findMany({
    where: { date: start, shift },
    select: { id: true, caddyId: true },
  });
  const nextSet = new Set(caddyIds);
  const removeIds = existing
    .filter((row) => !nextSet.has(row.caddyId))
    .map((row) => row.id);
  const existingIds = new Set(existing.map((row) => row.caddyId));
  const addIds = caddyIds.filter((id) => !existingIds.has(id));

  await prisma.$transaction(async (tx) => {
    if (removeIds.length) {
      await tx.dailySpecialSupport.deleteMany({ where: { id: { in: removeIds } } });
    }
    if (addIds.length) {
      await tx.dailySpecialSupport.createMany({
        data: addIds.map((caddyId) => ({
          date: start,
          caddyId,
          shift,
          createdByUserId: input.createdByUserId ?? null,
        })),
      });
    }
  });

  const items = (await listDailySpecialSupportRecords(ymd)).filter(
    (row) => row.shift === shift
  );
  return { items, added: addIds.length, removed: removeIds.length };
}

/**
 * 한 날짜 특수지원 큐를 한 번에 읽는다.
 * course/team/shift 루프에서 호출하지 말 것 — preview/reflow 요청당 1회.
 */
export async function loadSpecialSupportQueuesForDate(
  ymd: string,
  options?: { unavailables?: SpecialSupportUnavailable[] }
): Promise<Record<ShiftPart, AutoAssignCaddy[]>> {
  parseYmd(ymd);
  const { start } = parseYmd(ymd);
  const [rows, unavailables] = await Promise.all([
    prisma.dailySpecialSupport.findMany({
      where: { date: start },
      include: { caddy: { select: caddySelect } },
      orderBy: [{ id: "asc" }],
    }),
    options?.unavailables
      ? Promise.resolve(options.unavailables)
      : loadUnavailables(ymd),
  ]);
  const blocked = unavailableReasonsMap(unavailables);
  const out = emptySpecialSupportByShift();
  for (const row of rows) {
    if (!isSpecialSupportShift(row.shift)) continue;
    const caddy = toCaddy(row.caddy);
    if (isHardExcludedSpecialSupport(caddy)) continue;
    if (supportBlockedByUnavailable(blocked.get(row.caddyId), row.shift)) continue;
    out[row.shift].push(caddy);
  }
  return out;
}

export { SHIFT_PARTS };
