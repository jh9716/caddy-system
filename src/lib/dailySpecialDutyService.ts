/**
 * 날짜별 관리자 특수근무 저장 (Prisma). Production migrate deploy 없음.
 */

import { prisma } from "@/lib/prisma";
import { parseYmd } from "@/lib/availabilityEngine";
import {
  DAILY_SPECIAL_KIND_LABELS,
  DAILY_SPECIAL_KINDS,
  annotateSpecialDutyConflicts,
  buildEngineSpecialBundles,
  hasDuplicateKind,
  isDailySpecialKind,
  moveItemIndex,
  nextSortOrder,
  renumberSortOrders,
  resolvePastedSpecialNames,
  type DailySpecialKind,
  type SpecialDutyConflict,
  type SpecialDutyRecord,
} from "@/lib/dailySpecialDuty";
import type { NameMatchCaddy } from "@/lib/dailyCaddyNameMatch";

const caddySelect = {
  id: true,
  name: true,
  team: true,
  teamOrder: true,
  caddyType: true,
  employmentStatus: true,
} as const;

export class DailySpecialDutyError extends Error {
  status = 400;
  code = "daily_special_duty_invalid";
  constructor(message: string, code?: string, status?: number) {
    super(message);
    this.name = "DailySpecialDutyError";
    if (code) this.code = code;
    if (status) this.status = status;
  }
}

function dateRange(ymd: string) {
  return parseYmd(ymd);
}

function toRecord(row: {
  id: number;
  kind: string;
  caddyId: number;
  sortOrder: number;
  caddy: {
    id: number;
    name: string;
    team: string;
    teamOrder: number;
    caddyType: string;
    employmentStatus: string;
  };
}): SpecialDutyRecord {
  if (!isDailySpecialKind(row.kind)) {
    throw new DailySpecialDutyError(`알 수 없는 특수근무 유형: ${row.kind}`);
  }
  return {
    id: row.id,
    kind: row.kind,
    caddyId: row.caddyId,
    sortOrder: row.sortOrder,
    name: row.caddy.name,
    team: row.caddy.team,
    teamOrder: row.caddy.teamOrder,
    caddyType: row.caddy.caddyType,
    employmentStatus: row.caddy.employmentStatus,
  };
}

export async function listDailySpecialDutyRecords(
  ymd: string
): Promise<SpecialDutyRecord[]> {
  const { start, end } = dateRange(ymd);
  const rows = await prisma.dailySpecialDuty.findMany({
    where: { date: { gte: start, lte: end } },
    include: { caddy: { select: caddySelect } },
    orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
  });
  const byKind = new Map<DailySpecialKind, SpecialDutyRecord[]>();
  for (const kind of DAILY_SPECIAL_KINDS) byKind.set(kind, []);
  for (const row of rows) {
    const rec = toRecord(row);
    byKind.get(rec.kind)!.push(rec);
  }
  return DAILY_SPECIAL_KINDS.flatMap((kind) => byKind.get(kind) || []);
}

export function groupSpecialDuties(
  records: Array<SpecialDutyRecord & { conflicts: SpecialDutyConflict[] }>
) {
  return DAILY_SPECIAL_KINDS.map((kind) => {
    const items = records
      .filter((row) => row.kind === kind)
      .slice()
      .sort((a, b) => a.sortOrder - b.sortOrder || (a.id || 0) - (b.id || 0));
    return {
      kind,
      items,
      count: items.length,
    };
  });
}

export async function addDailySpecialDuties(input: {
  date: string;
  kind: DailySpecialKind;
  caddyIds?: number[];
  namesText?: string;
  caddies: NameMatchCaddy[];
}): Promise<{
  added: SpecialDutyRecord[];
  reviews: ReturnType<typeof resolvePastedSpecialNames>["reviews"];
  duplicates: Array<{ caddyId: number; name?: string }>;
}> {
  const { start, end } = dateRange(input.date);
  const kind = input.kind;

  const resolvedIds: Array<{ caddyId: number; name?: string }> = [];
  const seen = new Set<number>();
  for (const id of input.caddyIds || []) {
    const n = Number(id);
    if (!Number.isInteger(n) || n < 1) {
      throw new DailySpecialDutyError("caddyId가 올바르지 않습니다.");
    }
    if (seen.has(n)) continue;
    seen.add(n);
    resolvedIds.push({ caddyId: n });
  }
  const pasted = resolvePastedSpecialNames(input.namesText || "", input.caddies);
  for (const hit of pasted.matched) {
    if (seen.has(hit.caddyId)) continue;
    seen.add(hit.caddyId);
    resolvedIds.push(hit);
  }

  if (!resolvedIds.length && !pasted.reviews.length) {
    throw new DailySpecialDutyError("추가할 캐디가 없습니다.");
  }

  const existing = await prisma.dailySpecialDuty.findMany({
    where: { date: { gte: start, lte: end } },
    select: { kind: true, caddyId: true, sortOrder: true },
  });
  const kindOrders = existing
    .filter((row) => row.kind === kind)
    .map((row) => row.sortOrder);
  let cursor = nextSortOrder(kindOrders);
  const duplicates: Array<{ caddyId: number; name?: string }> = [];
  const toCreate: Array<{ caddyId: number; sortOrder: number; name?: string }> =
    [];

  for (const item of resolvedIds) {
    if (hasDuplicateKind(existing, kind, item.caddyId)) {
      duplicates.push(item);
      continue;
    }
    existing.push({ kind, caddyId: item.caddyId, sortOrder: cursor });
    toCreate.push({ ...item, sortOrder: cursor });
    cursor += 1;
  }

  if (!toCreate.length) {
    if (duplicates.length) {
      throw new DailySpecialDutyError(
        "같은 날짜·유형에 이미 등록된 캐디입니다.",
        "duplicate_kind",
        409
      );
    }
    return { added: [], reviews: pasted.reviews, duplicates };
  }

  const caddyIds = toCreate.map((row) => row.caddyId);
  const found = await prisma.caddy.findMany({
    where: { id: { in: caddyIds } },
    select: { id: true },
  });
  const foundIds = new Set(found.map((c) => c.id));
  const missing = caddyIds.filter((id) => !foundIds.has(id));
  if (missing.length) {
    throw new DailySpecialDutyError(
      `존재하지 않는 캐디입니다: ${missing.join(", ")}`,
      "caddy_not_found",
      404
    );
  }

  await prisma.$transaction(
    toCreate.map((row) =>
      prisma.dailySpecialDuty.create({
        data: {
          date: start,
          kind,
          caddyId: row.caddyId,
          sortOrder: row.sortOrder,
        },
      })
    )
  );

  const addedRows = await prisma.dailySpecialDuty.findMany({
    where: {
      date: { gte: start, lte: end },
      kind,
      caddyId: { in: toCreate.map((row) => row.caddyId) },
    },
    include: { caddy: { select: caddySelect } },
    orderBy: [{ sortOrder: "asc" }],
  });

  return {
    added: addedRows.map(toRecord),
    reviews: pasted.reviews,
    duplicates,
  };
}

async function loadKindRows(ymd: string, kind: DailySpecialKind) {
  const { start, end } = dateRange(ymd);
  return prisma.dailySpecialDuty.findMany({
    where: { date: { gte: start, lte: end }, kind },
    include: { caddy: { select: caddySelect } },
    orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
  });
}

async function persistRenumbered(
  rows: Array<{ id: number; sortOrder: number }>
) {
  const numbered = renumberSortOrders(rows);
  await prisma.$transaction(
    numbered.map((row) =>
      prisma.dailySpecialDuty.update({
        where: { id: row.id },
        data: { sortOrder: row.sortOrder },
      })
    )
  );
}

export async function deleteDailySpecialDuty(id: number): Promise<{
  date: string;
  kind: DailySpecialKind;
}> {
  const row = await prisma.dailySpecialDuty.findUnique({
    where: { id },
  });
  if (!row) {
    throw new DailySpecialDutyError("항목을 찾지 못했습니다.", "not_found", 404);
  }
  if (!isDailySpecialKind(row.kind)) {
    throw new DailySpecialDutyError(`알 수 없는 특수근무 유형: ${row.kind}`);
  }
  const ymd = toYmd(row.date);
  await prisma.dailySpecialDuty.delete({ where: { id } });
  const rest = await loadKindRows(ymd, row.kind);
  await persistRenumbered(rest.map((item) => ({ id: item.id, sortOrder: item.sortOrder })));
  return { date: ymd, kind: row.kind };
}

export async function moveDailySpecialDuty(
  id: number,
  direction: "up" | "down"
): Promise<{ date: string; kind: DailySpecialKind; records: SpecialDutyRecord[] }> {
  const row = await prisma.dailySpecialDuty.findUnique({ where: { id } });
  if (!row) {
    throw new DailySpecialDutyError("항목을 찾지 못했습니다.", "not_found", 404);
  }
  if (!isDailySpecialKind(row.kind)) {
    throw new DailySpecialDutyError(`알 수 없는 특수근무 유형: ${row.kind}`);
  }
  const ymd = toYmd(row.date);
  const rows = await loadKindRows(ymd, row.kind);
  const index = rows.findIndex((item) => item.id === id);
  const moved = moveItemIndex(rows, index, direction === "up" ? -1 : 1);
  await persistRenumbered(moved.map((item) => ({ id: item.id, sortOrder: item.sortOrder })));
  const next = await loadKindRows(ymd, row.kind);
  return { date: ymd, kind: row.kind, records: next.map(toRecord) };
}

export async function reorderDailySpecialDuties(input: {
  date: string;
  kind: DailySpecialKind;
  orderedCaddyIds: number[];
}): Promise<SpecialDutyRecord[]> {
  const rows = await loadKindRows(input.date, input.kind);
  const currentIds = rows.map((row) => row.caddyId);
  if (currentIds.length !== input.orderedCaddyIds.length) {
    throw new DailySpecialDutyError("순서 목록이 현재 인원과 일치하지 않습니다.");
  }
  const currentSet = new Set(currentIds);
  for (const id of input.orderedCaddyIds) {
    if (!currentSet.has(id)) {
      throw new DailySpecialDutyError("순서 목록에 없는 캐디가 있습니다.");
    }
  }
  if (new Set(input.orderedCaddyIds).size !== input.orderedCaddyIds.length) {
    throw new DailySpecialDutyError("순서 목록에 중복 캐디가 있습니다.");
  }
  const byCaddy = new Map(rows.map((row) => [row.caddyId, row]));
  const ordered = input.orderedCaddyIds.map((caddyId) => byCaddy.get(caddyId)!);
  await persistRenumbered(ordered.map((row) => ({ id: row.id, sortOrder: row.sortOrder })));
  const next = await loadKindRows(input.date, input.kind);
  return next.map(toRecord);
}

/** 화면에서 모은 순서/삭제를 한 트랜잭션으로 저장. */
export async function commitKindSpecialDuties(input: {
  date: string;
  kind: DailySpecialKind;
  orderedCaddyIds: number[];
  deleteIds?: number[];
}): Promise<SpecialDutyRecord[]> {
  const { start, end } = dateRange(input.date);
  const deleteIds = [...new Set((input.deleteIds || []).map(Number))].filter(
    (id) => Number.isInteger(id) && id > 0
  );
  if (deleteIds.length) {
    await prisma.dailySpecialDuty.deleteMany({
      where: {
        id: { in: deleteIds },
        date: { gte: start, lte: end },
        kind: input.kind,
      },
    });
  }
  if (input.orderedCaddyIds.length === 0) {
    return [];
  }
  return reorderDailySpecialDuties({
    date: input.date,
    kind: input.kind,
    orderedCaddyIds: input.orderedCaddyIds.map(Number),
  });
}

function toYmd(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function withConflicts(
  records: SpecialDutyRecord[],
  unavailableById: ReadonlyMap<number, string[]>
) {
  return annotateSpecialDutyConflicts(records, unavailableById);
}

export async function buildDailySpecialDutyPayload(date: string) {
  const records = await listDailySpecialDutyRecords(date);
  const caddies = await prisma.caddy.findMany({
    select: { id: true, employmentStatus: true },
  });
  const unavailable = new Map<number, string[]>();
  for (const caddy of caddies) {
    const emp = String(caddy.employmentStatus || "").toUpperCase();
    if (emp === "RETIRED") unavailable.set(caddy.id, ["퇴사(RETIRED)"]);
    else if (emp === "LEAVE") unavailable.set(caddy.id, ["휴직(LEAVE)"]);
    else if (emp !== "ACTIVE") {
      unavailable.set(caddy.id, [`재직상태 아님(${emp || "UNKNOWN"})`]);
    }
  }
  const annotated = withConflicts(records, unavailable);
  const groups = groupSpecialDuties(annotated).map((group) => ({
    kind: group.kind,
    label: DAILY_SPECIAL_KIND_LABELS[group.kind],
    count: group.count,
    items: group.items,
  }));
  const anchors = await listSpecialStartAnchors(date);
  return { date, groups, anchors };
}

export async function listSpecialStartAnchors(
  date: string
): Promise<{
  ONE_THREE: { course: string; teeTime: string } | null;
  ONE_MAK: { course: string; teeTime: string } | null;
}> {
  const { start, end } = dateRange(date);
  const rows = await prisma.dailySpecialDutyAnchor.findMany({
    where: { date: { gte: start, lte: end } },
  });
  const byKind = new Map(rows.map((row) => [row.kind, row]));
  const pick = (kind: DailySpecialKind) => {
    const row = byKind.get(kind);
    return row ? { course: row.course, teeTime: row.teeTime } : null;
  };
  return {
    ONE_THREE: pick("ONE_THREE"),
    ONE_MAK: pick("ONE_MAK"),
  };
}

export async function upsertSpecialStartAnchor(input: {
  date: string;
  kind: DailySpecialKind;
  course?: string | null;
  teeTime?: string | null;
}): Promise<{
  ONE_THREE: { course: string; teeTime: string } | null;
  ONE_MAK: { course: string; teeTime: string } | null;
}> {
  if (input.kind !== "ONE_THREE" && input.kind !== "ONE_MAK") {
    throw new DailySpecialDutyError(
      "시작 예약은 1·3부와 1막만 지정합니다.",
      "anchor_kind_invalid"
    );
  }
  const { start, end } = dateRange(input.date);
  const course = String(input.course || "").trim();
  const teeTime = String(input.teeTime || "").trim();
  const existing = await prisma.dailySpecialDutyAnchor.findFirst({
    where: { date: { gte: start, lte: end }, kind: input.kind },
  });
  if (!course || !teeTime) {
    if (existing) {
      await prisma.dailySpecialDutyAnchor.delete({ where: { id: existing.id } });
    }
    return listSpecialStartAnchors(input.date);
  }
  if (existing) {
    await prisma.dailySpecialDutyAnchor.update({
      where: { id: existing.id },
      data: { course, teeTime },
    });
  } else {
    await prisma.dailySpecialDutyAnchor.create({
      data: {
        date: start,
        kind: input.kind,
        course,
        teeTime,
      },
    });
  }
  return listSpecialStartAnchors(input.date);
}

export async function loadEngineSpecialBundlesForDate(
  date: string,
  unavailableById: ReadonlyMap<number, string[]>
) {
  const records = await listDailySpecialDutyRecords(date);
  const anchors = await listSpecialStartAnchors(date);
  return {
    records,
    anchors,
    bundles: buildEngineSpecialBundles(records, unavailableById),
  };
}
