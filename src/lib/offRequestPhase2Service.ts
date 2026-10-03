/**
 * OffRequest Phase 2 — 팀장 조정 / 팀 확정 / 관리자 월 전체 확정.
 * Assignment(OFF)가 최종 SoT. 자동배치 엔진은 수정하지 않는다.
 */

import { Prisma, type OffRequest, type OffRequestWindow, type PrismaClient } from "@prisma/client";
import { BLOCKING_ASSIGNMENT_TYPES } from "@/lib/availabilityEngine";
import { isPrimaryTeam, PRIMARY_TEAMS } from "@/lib/caddyManage";
import { isOffRequestLeader, type OffRequestActor } from "@/lib/offRequestAuth";
import {
  applyApproveDecision,
  canAdjustOffRequestWindow,
  canFinalizeOffRequestWindow,
  canTransitionOffRequestWindow,
  formatOffDateYmd,
  isOccupiedOverLimit,
  isYearMonth,
  offAssignmentDayRange,
  requireCalendarYmd,
  resolveDayQuotaLimit,
  yearMonthFromYmd,
  ymdDaysInYearMonth,
} from "@/lib/offRequestDomain";
import {
  OffRequestServiceError,
  countApprovedOffForTeamDays,
  serializeOffRequest,
  type DbClient,
} from "@/lib/offRequestService";
import {
  OFF_REQUEST_ADMIN_TEAMS,
  findWindowByMonth,
  requireWindowByMonth,
  serializeOffRequestWindow,
} from "@/lib/offRequestWindowService";

export type LeaderTeamContext = {
  team: string;
  caddyId: number;
  caddyName: string;
};

type TxClient = Prisma.TransactionClient;

const BLOCKING_SET = new Set<string>(BLOCKING_ASSIGNMENT_TYPES);

export async function withSerializableRetry<T>(
  db: PrismaClient,
  fn: (tx: TxClient) => Promise<T>,
  attempts = 3
): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await db.$transaction(fn, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 5000,
        timeout: 20000,
      });
    } catch (e) {
      last = e;
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        (e.code === "P2034" || e.code === "P4000")
      ) {
        continue;
      }
      throw e;
    }
  }
  throw last;
}

async function lockWindowRow(tx: TxClient, windowId: number) {
  await tx.$queryRaw<Array<{ id: number }>>`
    SELECT id FROM "OffRequestWindow" WHERE id = ${windowId} FOR UPDATE
  `;
}

function assertLeaderRole(actor: OffRequestActor) {
  if (!isOffRequestLeader(actor)) {
    throw new OffRequestServiceError(
      "forbidden",
      "팀장만 팀 휴무를 조정할 수 있습니다.",
      403
    );
  }
}

export async function resolveLeaderPrimaryTeam(
  db: DbClient,
  actor: OffRequestActor
): Promise<LeaderTeamContext> {
  assertLeaderRole(actor);
  if (actor.caddyId == null) {
    throw new OffRequestServiceError(
      "caddy_not_linked",
      "연결된 캐디 계정이 필요합니다.",
      403
    );
  }
  const caddy = await db.caddy.findUnique({
    where: { id: actor.caddyId },
    select: { id: true, name: true, team: true },
  });
  if (!caddy) {
    throw new OffRequestServiceError(
      "caddy_not_linked",
      "연결된 캐디를 찾을 수 없습니다.",
      403
    );
  }
  const team = String(caddy.team ?? "").trim();
  if (!isPrimaryTeam(team)) {
    throw new OffRequestServiceError(
      "no_primary_team",
      "PRIMARY 조에 속한 팀장만 조정할 수 있습니다.",
      403,
      { team }
    );
  }
  return { team, caddyId: caddy.id, caddyName: caddy.name };
}

function assertLeaderWriteActor(actor: OffRequestActor) {
  assertLeaderRole(actor);
  if (actor.userId == null) {
    throw new OffRequestServiceError(
      "user_required",
      "팀장 조정/확정에는 DB User 계정이 필요합니다.",
      403
    );
  }
}

function requireAdjustingWindow(window: OffRequestWindow) {
  if (!canAdjustOffRequestWindow(window.status)) {
    throw new OffRequestServiceError(
      "window_not_adjusting",
      window.status === "OPEN"
        ? "아직 신청 기간입니다"
        : window.status === "DRAFT"
          ? "아직 휴무 신청 전입니다."
          : "확정된 휴무는 변경할 수 없습니다.",
      409,
      { status: window.status }
    );
  }
}

async function requireTeamNotFinalized(
  db: DbClient,
  windowId: number,
  team: string
) {
  const row = await db.offRequestTeamFinalization.findUnique({
    where: { windowId_team: { windowId, team } },
  });
  if (row) {
    throw new OffRequestServiceError(
      "team_finalized",
      "이미 팀 확정이 끝났습니다.",
      409,
      {
        team,
        finalizedAt: row.finalizedAt.toISOString(),
        finalizedByUserId: row.finalizedByUserId,
      }
    );
  }
}

export type AssignmentConflict = {
  caddyId: number;
  caddyName: string;
  date: string;
  reason: string;
  assignmentId: number;
  assignmentType: string;
};

export async function findOffAssignmentConflicts(
  db: DbClient,
  items: Array<{ caddyId: number; caddyName: string; ymd: string }>
): Promise<AssignmentConflict[]> {
  const conflicts: AssignmentConflict[] = [];
  for (const item of items) {
    const { startDate, endDate } = offAssignmentDayRange(item.ymd);
    const hits = await db.assignment.findMany({
      where: {
        caddyId: item.caddyId,
        startDate: { lte: endDate },
        endDate: { gte: startDate },
      },
      select: { id: true, type: true },
    });
    for (const hit of hits) {
      if (!BLOCKING_SET.has(hit.type)) continue;
      const reason =
        hit.type === "OFF"
          ? "이미 확정 휴무(Assignment OFF)가 있습니다."
          : `${hit.type} 근무/불가와 휴무를 함께 둘 수 없습니다.`;
      conflicts.push({
        caddyId: item.caddyId,
        caddyName: item.caddyName,
        date: item.ymd,
        reason,
        assignmentId: hit.id,
        assignmentType: hit.type,
      });
    }
  }
  return conflicts;
}

function serializeFinalization(row: {
  team: string;
  finalizedAt: Date;
  finalizedByUserId: number | null;
}) {
  return {
    team: row.team,
    finalizedAt: row.finalizedAt.toISOString(),
    finalizedByUserId: row.finalizedByUserId,
  };
}

export type LeaderDayCell = {
  date: string;
  requestedCount: number;
  approvedCount: number;
  occupied: number;
  limit: number;
  over: boolean;
  overCount: number;
  override: boolean;
  requests: Array<{
    id: number;
    caddyId: number;
    caddyName: string;
    date: string;
    status: string;
  }>;
};

export async function getOffRequestLeaderTeamMonth(
  db: DbClient,
  actor: OffRequestActor,
  month: string
) {
  const leader = await resolveLeaderPrimaryTeam(db, actor);
  if (!isYearMonth(month)) {
    throw new OffRequestServiceError("invalid_month", "month=YYYY-MM 필요", 400);
  }
  const window = await findWindowByMonth(db, month);
  const days = ymdDaysInYearMonth(month);
  const start = requireCalendarYmd(days[0]);
  const end = requireCalendarYmd(days[days.length - 1]);

  const [rows, overrides, approvedByDate, finalization] = await Promise.all([
    db.offRequest.findMany({
      where: {
        date: { gte: start, lte: end },
        status: { in: ["REQUESTED", "APPROVED"] },
        caddy: { team: leader.team },
      },
      include: { caddy: { select: { id: true, name: true, team: true } } },
      orderBy: [{ date: "asc" }, { requestedAt: "asc" }, { id: "asc" }],
    }),
    window
      ? db.offRequestQuota.findMany({
          where: { windowId: window.id, team: leader.team },
        })
      : Promise.resolve([]),
    countApprovedOffForTeamDays(db, leader.team, days),
    window
      ? db.offRequestTeamFinalization.findUnique({
          where: { windowId_team: { windowId: window.id, team: leader.team } },
        })
      : Promise.resolve(null),
  ]);

  const requested = rows.filter((row) => row.status === "REQUESTED");
  const requestedByDate = new Map<string, typeof requested>();
  const displayByDate = new Map<string, typeof rows>();
  for (const row of rows) {
    const ymd = formatOffDateYmd(row.date);
    const display = displayByDate.get(ymd) ?? [];
    display.push(row);
    displayByDate.set(ymd, display);
    if (row.status !== "REQUESTED") continue;
    const list = requestedByDate.get(ymd) ?? [];
    list.push(row);
    requestedByDate.set(ymd, list);
  }
  const overrideByDate = new Map<string, number>();
  for (const row of overrides) {
    overrideByDate.set(formatOffDateYmd(row.date), row.limit);
  }
  const defaultQuota = window?.defaultQuota ?? 5;

  const dayCells: LeaderDayCell[] = days.map((date) => {
    const dayRequests = requestedByDate.get(date) ?? [];
    const displayRequests = displayByDate.get(date) ?? [];
    const requestedCount = dayRequests.length;
    const approvedCount = approvedByDate.get(date) ?? 0;
    const limit = resolveDayQuotaLimit({
      defaultQuota,
      overrideLimit: overrideByDate.get(date) ?? null,
    });
    const occupied = approvedCount + requestedCount;
    const over = isOccupiedOverLimit({ approvedCount, requestedCount, limit });
    return {
      date,
      requestedCount,
      approvedCount,
      occupied,
      limit,
      over,
      overCount: over ? occupied - limit : 0,
      override: overrideByDate.has(date),
      requests: displayRequests.map((row) => ({
        id: row.id,
        caddyId: row.caddy.id,
        caddyName: row.caddy.name,
        date,
        status: row.status,
      })),
    };
  });

  const overDays = dayCells.filter((d) => d.over);
  const canAdjust =
    window != null &&
    canAdjustOffRequestWindow(window.status) &&
    finalization == null;
  const canFinalize =
    canAdjust &&
    overDays.length === 0;

  return {
    month,
    team: leader.team,
    window: window ? serializeOffRequestWindow(window) : null,
    finalization: finalization ? serializeFinalization(finalization) : null,
    defaultQuota,
    requestedCount: requested.length,
    overDayCount: overDays.length,
    canAdjust,
    canFinalize,
    blockReasons: [
      !window ? "해당 월 신청 기간이 없습니다." : "",
      window && window.status === "OPEN" ? "아직 신청 기간입니다" : "",
      window && window.status === "DRAFT" ? "아직 휴무 신청 전입니다." : "",
      window && window.status === "FINALIZED" ? "확정된 휴무는 변경할 수 없습니다." : "",
      finalization ? "이미 팀 확정이 끝났습니다." : "",
      overDays.length
        ? overDays
            .map((d) => `${d.date.slice(5)} ${d.occupied} / ${d.limit} · ${d.overCount}명 초과`)
            .join(" · ")
        : "",
    ].filter(Boolean),
    days: dayCells.filter((d) => d.requestedCount > 0 || d.approvedCount > 0 || d.over),
    allDays: dayCells,
  };
}

async function assertNoActiveDuplicate(
  db: DbClient,
  caddyId: number,
  date: Date,
  exceptId: number
) {
  const existing = await db.offRequest.findFirst({
    where: {
      caddyId,
      date,
      status: { in: ["REQUESTED", "APPROVED"] },
      id: { not: exceptId },
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

export async function rescheduleTeamOffRequest(
  db: PrismaClient,
  actor: OffRequestActor,
  input: { id: number; toDate: string; reason?: string | null }
) {
  assertLeaderWriteActor(actor);
  const toYmd = String(input.toDate ?? "").trim();
  const toDate = requireCalendarYmd(toYmd);
  const reason =
    input.reason == null || String(input.reason).trim() === ""
      ? null
      : String(input.reason).trim().slice(0, 500);

  try {
    return await withSerializableRetry(db, async (tx) => {
      const leader = await resolveLeaderPrimaryTeam(tx, actor);
      const row = await tx.offRequest.findUnique({
        where: { id: input.id },
        include: { caddy: { select: { id: true, name: true, team: true } } },
      });
      if (!row) {
        throw new OffRequestServiceError("not_found", "신청을 찾을 수 없습니다.", 404);
      }
      if (String(row.caddy.team).trim() !== leader.team) {
        throw new OffRequestServiceError("team_forbidden", "다른 팀 신청은 바꿀 수 없습니다.", 403);
      }
      const fromYmd = formatOffDateYmd(row.date);
      if (fromYmd === toYmd) {
        throw new OffRequestServiceError("same_date", "같은 날짜로는 이동할 수 없습니다.", 400);
      }
      const month = yearMonthFromYmd(fromYmd);
      if (yearMonthFromYmd(toYmd) !== month) {
        throw new OffRequestServiceError("outside_window", "같은 달 안에서만 이동할 수 있습니다.", 400);
      }
      const window = await requireWindowByMonth(tx, month);
      await lockWindowRow(tx, window.id);
      const lockedWindow = await tx.offRequestWindow.findUniqueOrThrow({
        where: { id: window.id },
      });
      requireAdjustingWindow(lockedWindow);
      await requireTeamNotFinalized(tx, lockedWindow.id, leader.team);
      if (row.status !== "REQUESTED") {
        throw new OffRequestServiceError(
          "invalid_transition",
          "REQUESTED 상태만 날짜를 바꿀 수 있습니다.",
          409,
          { status: row.status }
        );
      }
      await assertNoActiveDuplicate(tx, row.caddyId, toDate, row.id);

      const switched = await tx.offRequest.updateMany({
        where: { id: row.id, status: "REQUESTED", date: row.date },
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
          offRequestId: row.id,
          fromDate: row.date,
          toDate,
          adjustedByUserId: actor.userId!,
          reason,
        },
      });
      const updated = await tx.offRequest.findUniqueOrThrow({ where: { id: row.id } });
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

export async function quotaOverDaysForTeam(
  tx: TxClient,
  window: OffRequestWindow,
  team: string,
  requests: Array<{ date: Date }>
) {
  const days = ymdDaysInYearMonth(window.yearMonth);
  const approvedByDate = await countApprovedOffForTeamDays(tx, team, days);
  const overrides = await tx.offRequestQuota.findMany({
    where: { windowId: window.id, team },
  });
  const overrideByDate = new Map<string, number>();
  for (const row of overrides) {
    overrideByDate.set(formatOffDateYmd(row.date), row.limit);
  }
  const requestedByDate = new Map<string, number>();
  for (const row of requests) {
    const ymd = formatOffDateYmd(row.date);
    requestedByDate.set(ymd, (requestedByDate.get(ymd) ?? 0) + 1);
  }
  const over: Array<{ date: string; occupied: number; limit: number; overCount: number }> = [];
  for (const date of days) {
    const requestedCount = requestedByDate.get(date) ?? 0;
    const approvedCount = approvedByDate.get(date) ?? 0;
    const limit = resolveDayQuotaLimit({
      defaultQuota: window.defaultQuota,
      overrideLimit: overrideByDate.get(date) ?? null,
    });
    if (isOccupiedOverLimit({ approvedCount, requestedCount, limit })) {
      const occupied = approvedCount + requestedCount;
      over.push({ date, occupied, limit, overCount: occupied - limit });
    }
  }
  return over;
}

async function approveRequestedAsOff(
  tx: TxClient,
  actor: OffRequestActor,
  row: OffRequest & { caddy: { id: number; name: string; team: string } }
) {
  const ymd = formatOffDateYmd(row.date);
  const prior = await tx.assignment.findFirst({
    where: { type: "OFF", comment: `OffRequest#${row.id}` },
    select: { id: true },
  });
  if (prior) {
    throw new OffRequestServiceError(
      "duplicate_off",
      "이 신청에 대한 Assignment(OFF)가 이미 있습니다.",
      409,
      { offRequestId: row.id, assignmentId: prior.id }
    );
  }
  const { startDate, endDate } = offAssignmentDayRange(ymd);
  const assignment = await tx.assignment.create({
    data: {
      caddyId: row.caddyId,
      type: "OFF",
      startDate,
      endDate,
      comment: `OffRequest#${row.id}`,
    },
  });
  const decision = applyApproveDecision({
    decidedByUserId: actor.userId,
    decisionNote: "team_finalized",
    assignmentId: assignment.id,
  });
  const switched = await tx.offRequest.updateMany({
    where: { id: row.id, status: "REQUESTED" },
    data: {
      status: decision.status,
      decidedAt: decision.decidedAt as Date,
      decidedByUserId: decision.decidedByUserId,
      decisionNote: decision.decisionNote,
      assignmentId: decision.assignmentId,
    },
  });
  if (switched.count !== 1) {
    throw new OffRequestServiceError(
      "invalid_transition",
      "REQUESTED 상태만 승인할 수 있습니다.",
      409
    );
  }
  return assignment.id;
}

async function executeTeamFinalize(
  db: PrismaClient,
  actor: OffRequestActor,
  month: string,
  resolveTeam: (tx: TxClient) => Promise<string>
) {
  try {
    return await withSerializableRetry(db, async (tx) => {
      const window = await requireWindowByMonth(tx, month);
      await lockWindowRow(tx, window.id);
      const team = await resolveTeam(tx);
      const lockedWindow = await tx.offRequestWindow.findUniqueOrThrow({
        where: { id: window.id },
      });
      requireAdjustingWindow(lockedWindow);

      const existing = await tx.offRequestTeamFinalization.findUnique({
        where: { windowId_team: { windowId: lockedWindow.id, team } },
      });
      if (existing) {
        return {
          alreadyFinalized: true,
          team,
          month: lockedWindow.yearMonth,
          approvedCount: 0,
          assignmentIds: [] as number[],
          finalization: serializeFinalization(existing),
        };
      }

      const days = ymdDaysInYearMonth(lockedWindow.yearMonth);
      const start = requireCalendarYmd(days[0]);
      const end = requireCalendarYmd(days[days.length - 1]);
      const requests = await tx.offRequest.findMany({
        where: {
          date: { gte: start, lte: end },
          status: "REQUESTED",
          caddy: { team },
        },
        include: { caddy: { select: { id: true, name: true, team: true } } },
        orderBy: [{ date: "asc" }, { id: "asc" }],
      });

      const overDays = await quotaOverDaysForTeam(tx, lockedWindow, team, requests);
      if (overDays.length > 0) {
        throw new OffRequestServiceError(
          "quota_exceeded",
          "정원 초과 날짜가 있어 팀 확정할 수 없습니다.",
          409,
          { overDays }
        );
      }

      const conflicts = await findOffAssignmentConflicts(
        tx,
        requests.map((row) => ({
          caddyId: row.caddyId,
          caddyName: row.caddy.name,
          ymd: formatOffDateYmd(row.date),
        }))
      );
      if (conflicts.length > 0) {
        throw new OffRequestServiceError(
          "assignment_conflict",
          "기존 Assignment와 충돌하는 휴무가 있습니다.",
          409,
          { conflicts }
        );
      }

      const assignmentIds: number[] = [];
      for (const row of requests) {
        assignmentIds.push(await approveRequestedAsOff(tx, actor, row));
      }

      const now = new Date();
      try {
        const finalization = await tx.offRequestTeamFinalization.create({
          data: {
            windowId: lockedWindow.id,
            team,
            finalizedAt: now,
            finalizedByUserId: actor.userId,
          },
        });
        return {
          alreadyFinalized: false,
          team,
          month: lockedWindow.yearMonth,
          approvedCount: requests.length,
          assignmentIds,
          finalization: serializeFinalization(finalization),
        };
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
          throw new OffRequestServiceError(
            "already_finalized",
            "이미 팀 확정이 끝났습니다.",
            409
          );
        }
        throw e;
      }
    });
  } catch (e) {
    if (e instanceof OffRequestServiceError) throw e;
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new OffRequestServiceError(
        "already_finalized",
        "이미 팀 확정이 끝났습니다.",
        409
      );
    }
    throw e;
  }
}

export async function finalizeTeamOffRequests(
  db: PrismaClient,
  actor: OffRequestActor,
  input: { month: string }
) {
  assertLeaderWriteActor(actor);
  if (!isYearMonth(input.month)) {
    throw new OffRequestServiceError("invalid_month", "month=YYYY-MM 필요", 400);
  }
  return executeTeamFinalize(db, actor, input.month, async (tx) => {
    const leader = await resolveLeaderPrimaryTeam(tx, actor);
    return leader.team;
  });
}

/** 관리자 대행 확정. 같은 quota/conflict transaction. leader로 위장하지 않음. */
export async function finalizeTeamOffRequestsAsAdmin(
  db: PrismaClient,
  actor: OffRequestActor,
  input: { month: string; team: string }
) {
  if (actor.role !== "admin") {
    throw new OffRequestServiceError("forbidden", "관리자만 팀을 대행 확정할 수 있습니다.", 403);
  }
  if (!isYearMonth(input.month)) {
    throw new OffRequestServiceError("invalid_month", "month=YYYY-MM 필요", 400);
  }
  const team = String(input.team ?? "").trim();
  if (!isPrimaryTeam(team)) {
    throw new OffRequestServiceError("invalid_team", "PRIMARY 조만 대행 확정할 수 있습니다.", 400);
  }
  return executeTeamFinalize(db, actor, input.month, async () => team);
}

export async function getOffRequestAdminProgress(
  db: DbClient,
  month: string
) {
  if (!isYearMonth(month)) {
    throw new OffRequestServiceError("invalid_month", "month=YYYY-MM 필요", 400);
  }
  const window = await findWindowByMonth(db, month);
  const teams = [...OFF_REQUEST_ADMIN_TEAMS];
  const rows = window
    ? await db.offRequestTeamFinalization.findMany({
        where: { windowId: window.id, team: { in: teams } },
      })
    : [];
  const byTeam = new Map(rows.map((r) => [r.team, r]));
  const progress = teams.map((team) => {
    const row = byTeam.get(team);
    return {
      team,
      finalized: Boolean(row),
      finalizedAt: row?.finalizedAt.toISOString() ?? null,
      finalizedByUserId: row?.finalizedByUserId ?? null,
    };
  });
  return {
    teamCount: teams.length,
    finalizedCount: progress.filter((p) => p.finalized).length,
    teams: progress,
  };
}

export async function finalizeOffRequestWindow(
  db: PrismaClient,
  actor: OffRequestActor,
  id: number
) {
  if (actor.role !== "admin") {
    throw new OffRequestServiceError("forbidden", "관리자만 월 전체를 확정할 수 있습니다.", 403);
  }

  return withSerializableRetry(db, async (tx) => {
    const row = await tx.offRequestWindow.findUnique({ where: { id } });
    if (!row) {
      throw new OffRequestServiceError("not_found", "신청 기간을 찾을 수 없습니다.", 404);
    }
    await lockWindowRow(tx, row.id);
    const window = await tx.offRequestWindow.findUniqueOrThrow({ where: { id } });
    if (!canFinalizeOffRequestWindow(window.status)) {
      throw new OffRequestServiceError(
        "invalid_transition",
        `${window.status}에서 FINALIZED(으)로 바꿀 수 없습니다.`,
        409,
        { status: window.status }
      );
    }
    if (!canTransitionOffRequestWindow(window.status, "FINALIZED")) {
      throw new OffRequestServiceError(
        "invalid_transition",
        `${window.status}에서 FINALIZED(으)로 바꿀 수 없습니다.`,
        409,
        { status: window.status }
      );
    }

    const progress = await getOffRequestAdminProgress(tx, window.yearMonth);
    if (progress.finalizedCount !== progress.teamCount) {
      throw new OffRequestServiceError(
        "teams_incomplete",
        "모든 팀이 확정되어야 월 전체를 확정할 수 있습니다.",
        409,
        { progress }
      );
    }

    const days = ymdDaysInYearMonth(window.yearMonth);
    const start = requireCalendarYmd(days[0]);
    const end = requireCalendarYmd(days[days.length - 1]);
    const leftover = await tx.offRequest.count({
      where: {
        date: { gte: start, lte: end },
        status: "REQUESTED",
      },
    });
    if (leftover > 0) {
      throw new OffRequestServiceError(
        "unresolved_requested",
        "미처리 REQUESTED 신청이 남아 있습니다.",
        409,
        { leftover }
      );
    }

    for (const team of PRIMARY_TEAMS) {
      const overDays = await quotaOverDaysForTeam(tx, window, team, []);
      if (overDays.length > 0) {
        throw new OffRequestServiceError(
          "quota_exceeded",
          "정원 초과 날짜가 있어 월 전체를 확정할 수 없습니다.",
          409,
          { team, overDays }
        );
      }
    }

    const approved = await tx.offRequest.findMany({
      where: {
        date: { gte: start, lte: end },
        status: "APPROVED",
      },
      include: { caddy: { select: { name: true } } },
    });
    const missing: Array<{ id: number; caddyName: string; date: string }> = [];
    for (const row of approved) {
      if (row.assignmentId == null) {
        missing.push({
          id: row.id,
          caddyName: row.caddy.name,
          date: formatOffDateYmd(row.date),
        });
        continue;
      }
      const linked = await tx.assignment.findUnique({
        where: { id: row.assignmentId },
        select: { id: true, type: true, caddyId: true },
      });
      if (!linked || linked.type !== "OFF" || linked.caddyId !== row.caddyId) {
        missing.push({
          id: row.id,
          caddyName: row.caddy.name,
          date: formatOffDateYmd(row.date),
        });
      }
    }
    if (missing.length > 0) {
      throw new OffRequestServiceError(
        "assignment_inconsistent",
        "승인된 휴무에 Assignment(OFF)가 없거나 끊겨 있습니다.",
        409,
        { missing }
      );
    }

    const now = new Date();
    const switched = await tx.offRequestWindow.updateMany({
      where: { id: window.id, status: "ADJUSTING" },
      data: {
        status: "FINALIZED",
        finalizedAt: now,
        finalizedByUserId: actor.userId,
      },
    });
    if (switched.count !== 1) {
      throw new OffRequestServiceError(
        "invalid_transition",
        "ADJUSTING 상태에서만 월 전체를 확정할 수 있습니다.",
        409
      );
    }
    return tx.offRequestWindow.findUniqueOrThrow({ where: { id: window.id } });
  });
}

export function serializeTeamOffRequest(row: OffRequest) {
  return serializeOffRequest(row);
}
