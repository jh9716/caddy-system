/**
 * 날짜·부별 특수지원 저장. DailySpecialDuty / CHAGEUN 과 분리.
 * Production migrate deploy 없음.
 */

import { prisma } from "@/lib/prisma";
import { parseYmd } from "@/lib/availabilityEngine";
import { loadAvailabilityForDate } from "@/lib/availabilityService";
import type { AutoAssignCaddy } from "@/lib/autoAssignEngine";
import { Prisma } from "@prisma/client";
import {
  countSupportByKind,
  emptySpecialSupportByShift,
  exclusionLabel,
  groupSupportRecordsByKindPattern,
  groupSupportRecordsByShift,
  isEligibleSpecialSupportCandidate,
  isEngineEligibleSupportRecord,
  isHardExcludedSpecialSupport,
  isSpecialSupportShift,
  resolveSupportKind,
  resolveSupportWorkPattern,
  shiftCompatFromWorkPattern,
  supportBlockedByUnavailable,
  uniqueCaddyIds,
  workPatternFromShift,
  DEFAULT_SPECIAL_SUPPORT_KIND,
  type DailySpecialSupportKind,
  type DailySpecialSupportWorkPattern,
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
      orderBy: [{ shift: "asc" }, { sortOrder: "asc" }, { id: "asc" }],
    }),
    loadUnavailables(ymd),
  ]);
  const blocked = unavailableReasonsMap(unavailables);
  return rows.map((row) => {
    const kind = resolveSupportKind(row);
    const workPattern = resolveSupportWorkPattern(row);
    const shift = String(row.shift || shiftCompatFromWorkPattern(workPattern));
    const reasons: string[] = [];
    if (isHardExcludedSpecialSupport(row.caddy)) {
      reasons.push(
        row.caddy.employmentStatus === "LEAVE" ? "휴직(LEAVE)" : "퇴사(RETIRED)"
      );
    }
    const unavail = blocked.get(row.caddyId);
    const unavailBlocked =
      isSpecialSupportShift(shift) &&
      supportBlockedByUnavailable(unavail, shift);
    const hardBlocked =
      isHardExcludedSpecialSupport(row.caddy) || unavailBlocked;
    return {
      id: row.id,
      date: ymd,
      caddyId: row.caddyId,
      shift,
      kind,
      workPattern,
      sortOrder: Number(row.sortOrder) || 0,
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
    byKindPattern: groupSupportRecordsByKindPattern(items),
    countsByKind: countSupportByKind(items),
    candidates,
    counts: {
      "1부": items.filter((row) => row.shift === "1부").length,
      "2부": items.filter((row) => row.shift === "2부").length,
      "3부": items.filter((row) => row.shift === "3부").length,
    },
  };
}

async function assertEligibleCaddyIds(ymd: string, caddyIds: number[]) {
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
}

function toYmd(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function uniqueConflictError(e: unknown): never {
  if (
    e instanceof Prisma.PrismaClientKnownRequestError &&
    e.code === "P2002"
  ) {
    throw new DailySpecialSupportError(
      "이미 이 날짜 같은 부에 지원 등록된 캐디입니다.",
      "duplicate_shift"
    );
  }
  throw e;
}

async function loadGroupRows(
  start: Date,
  kind: DailySpecialSupportKind,
  workPattern: DailySpecialSupportWorkPattern
) {
  return prisma.dailySpecialSupport.findMany({
    where: { date: start, kind, workPattern },
    orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
  });
}

async function renumberGroup(
  tx: Prisma.TransactionClient,
  rows: Array<{ id: number }>
) {
  for (let i = 0; i < rows.length; i++) {
    await tx.dailySpecialSupport.update({
      where: { id: rows[i].id },
      data: { sortOrder: i + 1 },
    });
  }
}

/** legacy PUT { date, shift, caddyIds } — SPECIAL_SUPPORT 단일부만 교체 */
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
  return replaceDailySpecialSupportGroup({
    date: ymd,
    kind: DEFAULT_SPECIAL_SUPPORT_KIND,
    workPattern: workPatternFromShift(shift),
    caddyIds: input.caddyIds,
    createdByUserId: input.createdByUserId,
  });
}

export async function replaceDailySpecialSupportGroup(input: {
  date: string;
  kind: DailySpecialSupportKind;
  workPattern: DailySpecialSupportWorkPattern;
  caddyIds: unknown[];
  createdByUserId?: number | null;
}): Promise<{ items: SpecialSupportRecord[]; added: number; removed: number }> {
  const ymd = input.date;
  parseYmd(ymd);
  const kind = input.kind;
  const workPattern = input.workPattern;
  const shift = shiftCompatFromWorkPattern(workPattern);
  const { start } = parseYmd(ymd);
  const caddyIds = uniqueCaddyIds(input.caddyIds);
  await assertEligibleCaddyIds(ymd, caddyIds);

  const existing = await loadGroupRows(start, kind, workPattern);
  const nextSet = new Set(caddyIds);
  const removeIds = existing
    .filter((row) => !nextSet.has(row.caddyId))
    .map((row) => row.id);
  const byCaddy = new Map(existing.map((row) => [row.caddyId, row]));

  try {
    await prisma.$transaction(async (tx) => {
      if (removeIds.length) {
        await tx.dailySpecialSupport.deleteMany({
          where: { id: { in: removeIds } },
        });
      }
      for (let i = 0; i < caddyIds.length; i++) {
        const caddyId = caddyIds[i];
        const row = byCaddy.get(caddyId);
        if (row) {
          await tx.dailySpecialSupport.update({
            where: { id: row.id },
            data: { sortOrder: i + 1, shift, kind, workPattern },
          });
        } else {
          // (date,caddyId,shift) unique. 같은 부 문자열의 다른 kind는
          // 이번 저장 요청의 kind로 옮긴다. 기존 SPECIAL_SUPPORT 전체를
          // OFF_SUPPORT로 일괄 변환하지 않는다.
          const conflict = await tx.dailySpecialSupport.findUnique({
            where: {
              date_caddyId_shift: { date: start, caddyId, shift },
            },
          });
          if (conflict) {
            await tx.dailySpecialSupport.update({
              where: { id: conflict.id },
              data: { sortOrder: i + 1, shift, kind, workPattern },
            });
          } else {
            await tx.dailySpecialSupport.create({
              data: {
                date: start,
                caddyId,
                shift,
                kind,
                workPattern,
                sortOrder: i + 1,
                createdByUserId: input.createdByUserId ?? null,
              },
            });
          }
        }
      }
    });
  } catch (e) {
    uniqueConflictError(e);
  }

  const items = (await listDailySpecialSupportRecords(ymd)).filter(
    (row) =>
      resolveSupportKind(row) === kind &&
      resolveSupportWorkPattern(row) === workPattern
  );
  const remaining = new Set(caddyIds);
  const added = caddyIds.filter((id) => !byCaddy.has(id)).length;
  const removed = existing.filter((row) => !remaining.has(row.caddyId)).length;
  return { items, added, removed };
}

export async function moveDailySpecialSupport(
  id: number,
  direction: "up" | "down"
): Promise<{ date: string }> {
  const row = await prisma.dailySpecialSupport.findUnique({ where: { id } });
  if (!row) {
    throw new DailySpecialSupportError("지원근무를 찾을 수 없습니다.", "not_found", 404);
  }
  const ymd = toYmd(row.date);
  const { start } = parseYmd(ymd);
  const kind = resolveSupportKind(row);
  const workPattern = resolveSupportWorkPattern(row);
  const group = await loadGroupRows(start, kind, workPattern);
  const index = group.findIndex((item) => item.id === id);
  const nextIndex = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || nextIndex < 0 || nextIndex >= group.length) {
    return { date: ymd };
  }
  const current = group[index];
  const swap = group[nextIndex];
  await prisma.$transaction([
    prisma.dailySpecialSupport.update({
      where: { id: current.id },
      data: { sortOrder: nextIndex + 1 },
    }),
    prisma.dailySpecialSupport.update({
      where: { id: swap.id },
      data: { sortOrder: index + 1 },
    }),
  ]);
  const after = await loadGroupRows(start, kind, workPattern);
  await prisma.$transaction(async (tx) => {
    await renumberGroup(tx, after);
  });
  return { date: ymd };
}

export async function deleteDailySpecialSupport(
  id: number
): Promise<{ date: string }> {
  const row = await prisma.dailySpecialSupport.findUnique({ where: { id } });
  if (!row) {
    throw new DailySpecialSupportError("지원근무를 찾을 수 없습니다.", "not_found", 404);
  }
  const ymd = toYmd(row.date);
  const { start } = parseYmd(ymd);
  const kind = resolveSupportKind(row);
  const workPattern = resolveSupportWorkPattern(row);
  await prisma.dailySpecialSupport.delete({ where: { id } });
  const rest = await loadGroupRows(start, kind, workPattern);
  await prisma.$transaction(async (tx) => {
    await renumberGroup(tx, rest);
  });
  return { date: ymd };
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
      orderBy: [{ shift: "asc" }, { sortOrder: "asc" }, { id: "asc" }],
    }),
    options?.unavailables
      ? Promise.resolve(options.unavailables)
      : loadUnavailables(ymd),
  ]);
  const blocked = unavailableReasonsMap(unavailables);
  const out = emptySpecialSupportByShift();
  for (const row of rows) {
    if (!isEngineEligibleSupportRecord(row)) continue;
    if (!isSpecialSupportShift(row.shift)) continue;
    const caddy = toCaddy(row.caddy);
    if (isHardExcludedSpecialSupport(caddy)) continue;
    if (supportBlockedByUnavailable(blocked.get(row.caddyId), row.shift)) continue;
    out[row.shift].push({
      ...caddy,
      inputOrder: Number(row.sortOrder) || 0,
      supportKind: resolveSupportKind(row),
      supportWorkPattern: resolveSupportWorkPattern(row),
    });
  }
  return out;
}

export { SHIFT_PARTS };
