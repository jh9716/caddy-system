/**
 * 월별 OffRequestWindow / quota / 캐디 캘린더 / 본인 reschedule.
 * Assignment(OFF) 생성·finalize는 Phase 1에서 하지 않는다.
 */

import { Prisma, type OffRequest, type OffRequestWindow, type PrismaClient } from "@prisma/client";
import { isRetiredCaddySessionBlocked } from "@/lib/auth";
import { PRIMARY_TEAMS } from "@/lib/caddyManage";
import { isPastKstYmd, kstYmd } from "@/lib/kstDate";
import {
  canSubmitOwnOffRequest,
  isOwnCaddy,
  type OffRequestActor,
} from "@/lib/offRequestAuth";
import {
  canTransitionOffRequestWindow,
  clampOffDefaultQuota,
  formatOffDateYmd,
  isOccupiedOverLimit,
  isYearMonth,
  normalizeOffDateInput,
  requireCalendarYmd,
  resolveDayQuotaLimit,
  yearMonthFromYmd,
  ymdDaysInYearMonth,
  type OffRequestWindowStatus,
} from "@/lib/offRequestDomain";
import {
  OffRequestServiceError,
  countApprovedOffForTeamDays,
  type DbClient,
  serializeOffRequest,
} from "@/lib/offRequestService";

export type WindowWriteNow = { now?: Date };

/** 관리자 quota/현황에 쓰는 실제 조 목록. 자유 입력 금지. */
export const OFF_REQUEST_ADMIN_TEAMS = PRIMARY_TEAMS;

function assertAdmin(actor: OffRequestActor) {
  if (actor.role !== "admin") {
    throw new OffRequestServiceError("forbidden", "관리자만 가능합니다.", 403);
  }
}

function parseIsoDate(value: unknown, field: string): Date {
  const raw = String(value ?? "").trim();
  const d = new Date(raw);
  if (!raw || Number.isNaN(d.getTime())) {
    throw new OffRequestServiceError("invalid_date", `${field}가 올바르지 않습니다.`, 400);
  }
  return d;
}

function assertQuotaWritable(window: OffRequestWindow) {
  if (window.status === "FINALIZED") {
    throw new OffRequestServiceError(
      "window_finalized",
      "확정된 달의 정원은 바꿀 수 없습니다.",
      409
    );
  }
  if (window.status === "ADJUSTING") {
    throw new OffRequestServiceError(
      "window_adjusting",
      "조정 중에는 정원을 바꿀 수 없습니다.",
      409
    );
  }
}

async function assertCaddyNotRetired(db: DbClient, actor: OffRequestActor) {
  if (actor.caddyId == null) return;
  const caddy = await db.caddy.findUnique({
    where: { id: actor.caddyId },
    select: { employmentStatus: true },
  });
  if (
    isRetiredCaddySessionBlocked({
      role: actor.role,
      caddyId: actor.caddyId,
      employmentStatus: caddy?.employmentStatus ?? null,
    })
  ) {
    throw new OffRequestServiceError(
      "retired",
      "퇴사 계정은 휴무 신청을 할 수 없습니다.",
      403
    );
  }
}

export async function findWindowByMonth(
  db: DbClient,
  yearMonth: string
): Promise<OffRequestWindow | null> {
  if (!isYearMonth(yearMonth)) {
    throw new OffRequestServiceError("invalid_month", "month=YYYY-MM 필요", 400);
  }
  return db.offRequestWindow.findUnique({ where: { yearMonth } });
}

export async function requireWindowByMonth(
  db: DbClient,
  yearMonth: string
): Promise<OffRequestWindow> {
  const window = await findWindowByMonth(db, yearMonth);
  if (!window) {
    throw new OffRequestServiceError(
      "window_not_found",
      "해당 월 휴무 신청 기간이 없습니다.",
      404
    );
  }
  return window;
}

export async function requireOpenWindowForYmd(
  db: DbClient,
  ymd: string
): Promise<OffRequestWindow> {
  const yearMonth = yearMonthFromYmd(ymd);
  const window = await findWindowByMonth(db, yearMonth);
  if (!window) {
    throw new OffRequestServiceError(
      "window_not_found",
      "해당 월 휴무 신청 기간이 없습니다.",
      404
    );
  }
  if (window.status !== "OPEN") {
    throw new OffRequestServiceError(
      "window_not_open",
      window.status === "DRAFT"
        ? "아직 휴무 신청 전입니다."
        : window.status === "ADJUSTING"
          ? "조정 중에는 변경할 수 없습니다."
          : "확정된 휴무는 변경할 수 없습니다.",
      409,
      { status: window.status }
    );
  }
  return window;
}

export function assertWritableOffDate(
  ymd: string,
  yearMonth: string,
  now: Date = new Date()
) {
  if (!isYearMonth(yearMonth) || yearMonthFromYmd(ymd) !== yearMonth) {
    throw new OffRequestServiceError(
      "outside_window",
      "신청 월 밖의 날짜입니다.",
      400,
      { yearMonth, date: ymd }
    );
  }
  if (isPastKstYmd(ymd, now)) {
    throw new OffRequestServiceError(
      "past_date",
      "지난 날짜에는 신청할 수 없습니다.",
      400,
      { date: ymd, today: kstYmd(now) }
    );
  }
}

export function serializeOffRequestWindow(row: OffRequestWindow) {
  return {
    id: row.id,
    yearMonth: row.yearMonth,
    status: row.status,
    openAt: row.openAt.toISOString(),
    closeAt: row.closeAt.toISOString(),
    adjustingAt: row.adjustingAt ? row.adjustingAt.toISOString() : null,
    finalizedAt: row.finalizedAt ? row.finalizedAt.toISOString() : null,
    finalizedByUserId: row.finalizedByUserId,
    defaultQuota: row.defaultQuota,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function getOffRequestWindow(
  db: DbClient,
  month: string
): Promise<OffRequestWindow | null> {
  return findWindowByMonth(db, month);
}

export async function createOffRequestWindow(
  db: PrismaClient,
  actor: OffRequestActor,
  input: { yearMonth: string; openAt: string; closeAt: string; defaultQuota?: number }
): Promise<OffRequestWindow> {
  assertAdmin(actor);
  if (!isYearMonth(input.yearMonth)) {
    throw new OffRequestServiceError("invalid_month", "yearMonth=YYYY-MM 필요", 400);
  }
  let defaultQuota = 5;
  try {
    defaultQuota = clampOffDefaultQuota(input.defaultQuota ?? 5);
  } catch {
    throw new OffRequestServiceError("invalid_quota", "defaultQuota는 1-99입니다.", 400);
  }
  const openAt = parseIsoDate(input.openAt, "openAt");
  const closeAt = parseIsoDate(input.closeAt, "closeAt");
  if (closeAt.getTime() <= openAt.getTime()) {
    throw new OffRequestServiceError(
      "invalid_schedule",
      "closeAt은 openAt보다 뒤여야 합니다.",
      400
    );
  }

  try {
    return await db.offRequestWindow.create({
      data: {
        yearMonth: input.yearMonth,
        status: "DRAFT",
        openAt,
        closeAt,
        defaultQuota,
      },
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new OffRequestServiceError(
        "window_exists",
        "해당 월 신청 기간이 이미 있습니다.",
        409,
        { yearMonth: input.yearMonth }
      );
    }
    throw e;
  }
}

export async function updateOffRequestWindow(
  db: PrismaClient,
  actor: OffRequestActor,
  id: number,
  input: { openAt?: string; closeAt?: string; defaultQuota?: number }
): Promise<OffRequestWindow> {
  assertAdmin(actor);
  const row = await db.offRequestWindow.findUnique({ where: { id } });
  if (!row) {
    throw new OffRequestServiceError("not_found", "신청 기간을 찾을 수 없습니다.", 404);
  }
  if (row.status !== "DRAFT") {
    throw new OffRequestServiceError(
      "invalid_transition",
      "DRAFT 상태에서만 일정/정원을 수정할 수 있습니다.",
      409,
      { status: row.status }
    );
  }

  const data: Prisma.OffRequestWindowUpdateInput = {};
  if (input.openAt != null) data.openAt = parseIsoDate(input.openAt, "openAt");
  if (input.closeAt != null) data.closeAt = parseIsoDate(input.closeAt, "closeAt");
  if (input.defaultQuota != null) {
    try {
      data.defaultQuota = clampOffDefaultQuota(input.defaultQuota);
    } catch {
      throw new OffRequestServiceError("invalid_quota", "defaultQuota는 1-99입니다.", 400);
    }
  }
  const nextOpen = (data.openAt as Date | undefined) ?? row.openAt;
  const nextClose = (data.closeAt as Date | undefined) ?? row.closeAt;
  if (nextClose.getTime() <= nextOpen.getTime()) {
    throw new OffRequestServiceError(
      "invalid_schedule",
      "closeAt은 openAt보다 뒤여야 합니다.",
      400
    );
  }
  if (Object.keys(data).length === 0) return row;
  const switched = await db.offRequestWindow.updateMany({
    where: { id, status: "DRAFT" },
    data,
  });
  if (switched.count !== 1) {
    throw new OffRequestServiceError(
      "invalid_transition",
      "DRAFT 상태에서만 일정/정원을 수정할 수 있습니다.",
      409
    );
  }
  return db.offRequestWindow.findUniqueOrThrow({ where: { id } });
}

async function transitionWindow(
  db: PrismaClient,
  actor: OffRequestActor,
  id: number,
  to: OffRequestWindowStatus,
  extra: Prisma.OffRequestWindowUpdateInput = {}
): Promise<OffRequestWindow> {
  assertAdmin(actor);
  const row = await db.offRequestWindow.findUnique({ where: { id } });
  if (!row) {
    throw new OffRequestServiceError("not_found", "신청 기간을 찾을 수 없습니다.", 404);
  }
  if (!canTransitionOffRequestWindow(row.status, to)) {
    throw new OffRequestServiceError(
      "invalid_transition",
      `${row.status}에서 ${to}(으)로 바꿀 수 없습니다.`,
      409,
      { status: row.status, to }
    );
  }
  const switched = await db.offRequestWindow.updateMany({
    where: { id, status: row.status },
    data: { status: to, ...extra },
  });
  if (switched.count !== 1) {
    throw new OffRequestServiceError(
      "invalid_transition",
      `${row.status}에서 ${to}(으)로 바꿀 수 없습니다.`,
      409,
      { status: row.status, to }
    );
  }
  return db.offRequestWindow.findUniqueOrThrow({ where: { id } });
}

export async function openOffRequestWindow(
  db: PrismaClient,
  actor: OffRequestActor,
  id: number
): Promise<OffRequestWindow> {
  return transitionWindow(db, actor, id, "OPEN");
}

export async function closeOffRequestWindow(
  db: PrismaClient,
  actor: OffRequestActor,
  id: number,
  input: WindowWriteNow = {}
): Promise<OffRequestWindow> {
  return transitionWindow(db, actor, id, "ADJUSTING", {
    adjustingAt: input.now ?? new Date(),
  });
}

export async function upsertOffRequestQuota(
  db: PrismaClient,
  actor: OffRequestActor,
  input: { month: string; team: string; date: string; limit: number }
): Promise<{ window: OffRequestWindow; team: string; date: string; limit: number }> {
  assertAdmin(actor);
  const window = await requireWindowByMonth(db, input.month);
  assertQuotaWritable(window);
  const ymd = String(input.date ?? "").trim();
  try {
    requireCalendarYmd(ymd);
  } catch {
    throw new OffRequestServiceError("invalid_date", "date=YYYY-MM-DD 필요", 400);
  }
  if (yearMonthFromYmd(ymd) !== window.yearMonth) {
    throw new OffRequestServiceError("outside_window", "신청 월 밖의 날짜입니다.", 400);
  }
  const team = String(input.team ?? "").trim();
  if (!team) {
    throw new OffRequestServiceError("invalid_team", "team이 필요합니다.", 400);
  }
  let limit = 0;
  try {
    limit = clampOffDefaultQuota(input.limit);
  } catch {
    throw new OffRequestServiceError("invalid_quota", "limit는 1-99입니다.", 400);
  }
  const date = requireCalendarYmd(ymd);
  await db.offRequestQuota.upsert({
    where: {
      windowId_team_date: {
        windowId: window.id,
        team,
        date,
      },
    },
    create: { windowId: window.id, team, date, limit },
    update: { limit },
  });
  return { window, team, date: ymd, limit };
}

export async function deleteOffRequestQuota(
  db: PrismaClient,
  actor: OffRequestActor,
  input: { month: string; team: string; date: string }
): Promise<{ window: OffRequestWindow; team: string; date: string; deleted: number }> {
  assertAdmin(actor);
  const window = await requireWindowByMonth(db, input.month);
  assertQuotaWritable(window);
  const ymd = String(input.date ?? "").trim();
  try {
    requireCalendarYmd(ymd);
  } catch {
    throw new OffRequestServiceError("invalid_date", "date=YYYY-MM-DD 필요", 400);
  }
  if (yearMonthFromYmd(ymd) !== window.yearMonth) {
    throw new OffRequestServiceError("outside_window", "신청 월 밖의 날짜입니다.", 400);
  }
  const team = String(input.team ?? "").trim();
  if (!team) {
    throw new OffRequestServiceError("invalid_team", "team이 필요합니다.", 400);
  }
  const date = requireCalendarYmd(ymd);
  const deleted = await db.offRequestQuota.deleteMany({
    where: { windowId: window.id, team, date },
  });
  return { window, team, date: ymd, deleted: deleted.count };
}

export type AdminMonthTeamCell = {
  team: string;
  requestedCount: number;
  approvedCount: number;
  occupied: number;
  limit: number;
  over: boolean;
  override: boolean;
};

export type AdminMonthDay = {
  date: string;
  requestedCount: number;
  approvedCount: number;
  occupied: number;
  overTeamCount: number;
  teams: AdminMonthTeamCell[];
};

export async function getOffRequestAdminMonth(
  db: DbClient,
  actor: OffRequestActor,
  month: string
): Promise<{
  month: string;
  today: string;
  teams: readonly string[];
  window: ReturnType<typeof serializeOffRequestWindow> | null;
  quotas: Array<{ team: string; date: string; limit: number }>;
  days: AdminMonthDay[];
}> {
  assertAdmin(actor);
  if (!isYearMonth(month)) {
    throw new OffRequestServiceError("invalid_month", "month=YYYY-MM 필요", 400);
  }
  const window = await findWindowByMonth(db, month);
  const days = ymdDaysInYearMonth(month);
  const start = normalizeOffDateInput(days[0]);
  const end = normalizeOffDateInput(days[days.length - 1]);
  const teams = OFF_REQUEST_ADMIN_TEAMS;

  const [requests, overrides] = await Promise.all([
    db.offRequest.findMany({
      where: {
        date: { gte: start, lte: end },
        status: "REQUESTED",
        caddy: { team: { in: [...teams] } },
      },
      select: { date: true, caddy: { select: { team: true } } },
    }),
    window
      ? db.offRequestQuota.findMany({ where: { windowId: window.id } })
      : Promise.resolve([]),
  ]);

  const requested = new Map<string, number>();
  for (const row of requests) {
    const key = `${row.caddy.team}|${formatOffDateYmd(row.date)}`;
    requested.set(key, (requested.get(key) ?? 0) + 1);
  }

  const overrideMap = new Map<string, number>();
  const quotas: Array<{ team: string; date: string; limit: number }> = [];
  for (const row of overrides) {
    const date = formatOffDateYmd(row.date);
    overrideMap.set(`${row.team}|${date}`, row.limit);
    quotas.push({ team: row.team, date, limit: row.limit });
  }

  const approvedByTeam = new Map<string, Map<string, number>>();
  for (const team of teams) {
    approvedByTeam.set(team, await countApprovedOffForTeamDays(db, team, days));
  }

  const defaultQuota = window?.defaultQuota ?? 5;
  return {
    month,
    today: kstYmd(),
    teams,
    window: window ? serializeOffRequestWindow(window) : null,
    quotas,
    days: days.map((date) => {
      const teamCells = teams.map((team) => {
        const requestedCount = requested.get(`${team}|${date}`) ?? 0;
        const approvedCount = approvedByTeam.get(team)?.get(date) ?? 0;
        const overrideLimit = overrideMap.get(`${team}|${date}`);
        const limit = resolveDayQuotaLimit({
          defaultQuota,
          overrideLimit: overrideLimit ?? null,
        });
        return {
          team,
          requestedCount,
          approvedCount,
          occupied: approvedCount + requestedCount,
          limit,
          over: isOccupiedOverLimit({ approvedCount, requestedCount, limit }),
          override: overrideLimit != null,
        };
      });
      return {
        date,
        requestedCount: teamCells.reduce((n, c) => n + c.requestedCount, 0),
        approvedCount: teamCells.reduce((n, c) => n + c.approvedCount, 0),
        occupied: teamCells.reduce((n, c) => n + c.occupied, 0),
        overTeamCount: teamCells.filter((c) => c.over).length,
        teams: teamCells,
      };
    }),
  };
}

export type CalendarDay = {
  date: string;
  limit: number;
  requestedCount: number;
  /** Assignment(OFF) SoT. APPROVED OffRequest는 여기로만 반영. */
  approvedCount: number;
  mine: ReturnType<typeof serializeOffRequest> | null;
  over: boolean;
};

export async function getOffRequestCalendar(
  db: DbClient,
  actor: OffRequestActor,
  month: string
): Promise<{
  month: string;
  today: string;
  window: ReturnType<typeof serializeOffRequestWindow> | null;
  days: CalendarDay[];
}> {
  if (!isYearMonth(month)) {
    throw new OffRequestServiceError("invalid_month", "month=YYYY-MM 필요", 400);
  }
  const window = await findWindowByMonth(db, month);
  const days = ymdDaysInYearMonth(month);
  const start = normalizeOffDateInput(days[0]);
  const end = normalizeOffDateInput(days[days.length - 1]);

  let team = "";
  if (actor.caddyId != null) {
    const caddy = await db.caddy.findUnique({
      where: { id: actor.caddyId },
      select: { team: true },
    });
    team = String(caddy?.team ?? "").trim();
  }

  const [requests, overrides] = await Promise.all([
    team
      ? db.offRequest.findMany({
          where: {
            date: { gte: start, lte: end },
            status: "REQUESTED",
            caddy: { team },
          },
          select: {
            id: true,
            caddyId: true,
            date: true,
            status: true,
            requestedAt: true,
            note: true,
            decidedAt: true,
            decidedByUserId: true,
            decisionNote: true,
            assignmentId: true,
            createdAt: true,
            updatedAt: true,
          },
        })
      : Promise.resolve([]),
    window
      ? db.offRequestQuota.findMany({
          where: {
            windowId: window.id,
            ...(team ? { team } : { id: -1 }),
          },
        })
      : Promise.resolve([]),
  ]);

  const requestedByDate = new Map<string, number>();
  const mineByDate = new Map<string, (typeof requests)[number]>();
  for (const row of requests) {
    const ymd = formatOffDateYmd(row.date);
    requestedByDate.set(ymd, (requestedByDate.get(ymd) ?? 0) + 1);
    if (actor.caddyId != null && row.caddyId === actor.caddyId) {
      mineByDate.set(ymd, row);
    }
  }

  // mine이 CANCELLED가 아닌 자기 REQUESTED만 위에서 잡힘. APPROVED도 강조하려면 추가 조회.
  if (actor.caddyId != null) {
    const ownActive = await db.offRequest.findMany({
      where: {
        caddyId: actor.caddyId,
        date: { gte: start, lte: end },
        status: { in: ["REQUESTED", "APPROVED"] },
      },
    });
    for (const row of ownActive) {
      mineByDate.set(formatOffDateYmd(row.date), row);
    }
  }

  const overrideByDate = new Map<string, number>();
  for (const row of overrides) {
    overrideByDate.set(formatOffDateYmd(row.date), row.limit);
  }
  const defaultQuota = window?.defaultQuota ?? 5;
  const approvedByDate = team
    ? await countApprovedOffForTeamDays(db, team, days)
    : new Map<string, number>();

  return {
    month,
    today: kstYmd(),
    window: window ? serializeOffRequestWindow(window) : null,
    days: days.map((date) => {
      const requestedCount = requestedByDate.get(date) ?? 0;
      const approvedCount = approvedByDate.get(date) ?? 0;
      const limit = resolveDayQuotaLimit({
        defaultQuota,
        overrideLimit: overrideByDate.get(date) ?? null,
      });
      const mineRow = mineByDate.get(date) ?? null;
      return {
        date,
        limit,
        requestedCount,
        approvedCount,
        mine: mineRow ? serializeOffRequest(mineRow as OffRequest) : null,
        over: isOccupiedOverLimit({ approvedCount, requestedCount, limit }),
      };
    }),
  };
}

async function assertNoActiveDuplicate(
  db: DbClient,
  caddyId: number,
  date: Date,
  exceptId?: number
) {
  const existing = await db.offRequest.findFirst({
    where: {
      caddyId,
      date,
      status: { in: ["REQUESTED", "APPROVED"] },
      ...(exceptId != null ? { id: { not: exceptId } } : {}),
    },
    select: { id: true, status: true },
  });
  if (existing) {
    throw new OffRequestServiceError(
      "duplicate_active",
      "동일 날짜에 진행 중/승인된 휴무 신청이 있습니다.",
      409,
      { existingId: existing.id, status: existing.status }
    );
  }
}

export async function rescheduleOwnOffRequest(
  db: PrismaClient,
  actor: OffRequestActor,
  id: number,
  input: { toDate: string; reason?: string | null; now?: Date }
): Promise<{ offRequest: OffRequest; adjustmentId: number }> {
  if (!canSubmitOwnOffRequest(actor) || actor.caddyId == null) {
    throw new OffRequestServiceError(
      "caddy_not_linked",
      "캐디 계정 연결(caddyId)이 필요합니다.",
      403
    );
  }
  if (actor.userId == null) {
    throw new OffRequestServiceError(
      "user_required",
      "날짜 변경에는 DB User 계정이 필요합니다.",
      403
    );
  }
  await assertCaddyNotRetired(db, actor);

  const row = await db.offRequest.findUnique({ where: { id } });
  if (!row) {
    throw new OffRequestServiceError("not_found", "신청을 찾을 수 없습니다.", 404);
  }
  if (!isOwnCaddy(actor, row.caddyId)) {
    throw new OffRequestServiceError("forbidden", "본인 신청만 변경할 수 있습니다.", 403);
  }
  if (row.status !== "REQUESTED") {
    throw new OffRequestServiceError(
      "invalid_transition",
      "REQUESTED 상태만 날짜를 바꿀 수 있습니다.",
      409,
      { status: row.status }
    );
  }

  const reason =
    input.reason == null || String(input.reason).trim() === ""
      ? null
      : String(input.reason).trim().slice(0, 500);
  const now = input.now ?? new Date();
  const toYmd = String(input.toDate ?? "").trim();
  const toDate = requireCalendarYmd(toYmd);

  try {
    return await db.$transaction(async (tx) => {
      const locked = await tx.offRequest.findUnique({ where: { id } });
      if (!locked) {
        throw new OffRequestServiceError("not_found", "신청을 찾을 수 없습니다.", 404);
      }
      if (!isOwnCaddy(actor, locked.caddyId)) {
        throw new OffRequestServiceError("forbidden", "본인 신청만 변경할 수 있습니다.", 403);
      }
      if (locked.status !== "REQUESTED") {
        throw new OffRequestServiceError(
          "invalid_transition",
          "REQUESTED 상태만 날짜를 바꿀 수 있습니다.",
          409,
          { status: locked.status }
        );
      }
      const fromYmd = formatOffDateYmd(locked.date);
      if (fromYmd === toYmd) {
        throw new OffRequestServiceError("same_date", "같은 날짜로는 이동할 수 없습니다.", 400);
      }
      if (yearMonthFromYmd(fromYmd) !== yearMonthFromYmd(toYmd)) {
        throw new OffRequestServiceError(
          "outside_window",
          "같은 달 안에서만 이동할 수 있습니다.",
          400
        );
      }
      const window = await requireOpenWindowForYmd(tx, toYmd);
      assertWritableOffDate(fromYmd, window.yearMonth, now);
      assertWritableOffDate(toYmd, window.yearMonth, now);
      await assertNoActiveDuplicate(tx, actor.caddyId, toDate, locked.id);

      const switched = await tx.offRequest.updateMany({
        where: { id: locked.id, status: "REQUESTED", date: locked.date },
        data: { date: toDate },
      });
      if (switched.count !== 1) {
        throw new OffRequestServiceError(
          "invalid_transition",
          "REQUESTED 상태만 날짜를 바꿀 수 있습니다.",
          409
        );
      }
      const adjustment = await tx.offRequestAdjustment.create({
        data: {
          offRequestId: locked.id,
          fromDate: locked.date,
          toDate,
          adjustedByUserId: actor.userId!,
          reason,
        },
      });
      const updated = await tx.offRequest.findUniqueOrThrow({ where: { id: locked.id } });
      return { offRequest: updated, adjustmentId: adjustment.id };
    });
  } catch (e) {
    if (e instanceof OffRequestServiceError) throw e;
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new OffRequestServiceError(
        "duplicate_active",
        "동일 날짜에 진행 중/승인된 휴무 신청이 있습니다.",
        409
      );
    }
    throw e;
  }
}

export { assertCaddyNotRetired };
