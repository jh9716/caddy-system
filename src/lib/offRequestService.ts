/**
 * OffRequest 애플리케이션 서비스 (Prisma I/O)
 * - Assignment(OFF) = 확정 source
 * - OffRequest = workflow / 이력 (물리 삭제 금지)
 */

import { Prisma, type OffRequest, type PrismaClient } from "@prisma/client";
import {
  canAccessTeam,
  canManageOffRequests,
  canSubmitOwnOffRequest,
  isOwnCaddy,
  resolveTeamFilter,
  type OffRequestActor,
} from "@/lib/offRequestAuth";
import {
  applyApproveDecision,
  applyRejectDecision,
  applyRevokePreservingApprovalAudit,
  canApproveAgainstQuota,
  canTransitionOffRequest,
  computeOffQuotaSnapshot,
  formatOffDateYmd,
  normalizeOffDateInput,
  offAssignmentDayRange,
  type OffQuotaSnapshot,
} from "@/lib/offRequestDomain";

export type DbClient = PrismaClient | Prisma.TransactionClient;

export class OffRequestServiceError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number = 400,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "OffRequestServiceError";
  }
}

function dayBounds(ymd: string) {
  return offAssignmentDayRange(ymd);
}

/** 조·날짜 기준 확정 OFF 수 (수동/레거시 Assignment OFF 포함) */
export async function countApprovedOffForTeamDay(
  db: DbClient,
  team: string,
  ymd: string
): Promise<number> {
  const { startDate, endDate } = dayBounds(ymd);
  const caddies = await db.caddy.findMany({
    where: { team },
    select: { id: true },
  });
  if (caddies.length === 0) return 0;
  return db.assignment.count({
    where: {
      type: "OFF",
      caddyId: { in: caddies.map((c) => c.id) },
      startDate: { lte: endDate },
      endDate: { gte: startDate },
    },
  });
}

export async function countRequestedOffForTeamDay(
  db: DbClient,
  team: string,
  ymd: string
): Promise<number> {
  const date = normalizeOffDateInput(ymd);
  return db.offRequest.count({
    where: {
      status: "REQUESTED",
      date,
      caddy: { team },
    },
  });
}

export async function getTeamDayQuotaSnapshot(
  db: DbClient,
  team: string,
  ymd: string
): Promise<OffQuotaSnapshot> {
  const [approvedCount, requestedCount] = await Promise.all([
    countApprovedOffForTeamDay(db, team, ymd),
    countRequestedOffForTeamDay(db, team, ymd),
  ]);
  return computeOffQuotaSnapshot({ approvedCount, requestedCount });
}

async function assertNoActiveDuplicate(
  db: DbClient,
  caddyId: number,
  date: Date
) {
  const existing = await db.offRequest.findFirst({
    where: {
      caddyId,
      date,
      status: { in: ["REQUESTED", "APPROVED"] },
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

async function assertNoExistingOffAssignment(
  db: DbClient,
  caddyId: number,
  ymd: string
) {
  const { startDate, endDate } = dayBounds(ymd);
  const hit = await db.assignment.findFirst({
    where: {
      caddyId,
      type: "OFF",
      startDate: { lte: endDate },
      endDate: { gte: startDate },
    },
    select: { id: true },
  });
  if (hit) {
    throw new OffRequestServiceError(
      "already_off_assigned",
      "해당 날짜에 이미 확정 휴무(Assignment OFF)가 있습니다.",
      409,
      { assignmentId: hit.id }
    );
  }
}

export async function submitOffRequest(
  db: PrismaClient,
  actor: OffRequestActor,
  input: { date: string; note?: string | null }
): Promise<OffRequest> {
  if (!canSubmitOwnOffRequest(actor) || actor.caddyId == null) {
    throw new OffRequestServiceError(
      "caddy_not_linked",
      "캐디 계정 연결(caddyId)이 필요합니다.",
      403
    );
  }
  const ymd = input.date;
  const date = normalizeOffDateInput(ymd);
  const note =
    input.note == null || String(input.note).trim() === ""
      ? null
      : String(input.note).trim().slice(0, 500);

  await assertNoActiveDuplicate(db, actor.caddyId, date);
  await assertNoExistingOffAssignment(db, actor.caddyId, ymd);

  try {
    return await db.offRequest.create({
      data: {
        caddyId: actor.caddyId,
        date,
        status: "REQUESTED",
        note,
        requestedAt: new Date(),
      },
    });
  } catch (e) {
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === "P2002"
    ) {
      throw new OffRequestServiceError(
        "duplicate_active",
        "동일 날짜에 진행 중/승인된 휴무 신청이 있습니다.",
        409
      );
    }
    throw e;
  }
}

export async function listMyOffRequests(
  db: DbClient,
  actor: OffRequestActor
): Promise<OffRequest[]> {
  if (actor.caddyId == null) {
    throw new OffRequestServiceError(
      "caddy_not_linked",
      "캐디 계정 연결(caddyId)이 필요합니다.",
      403
    );
  }
  return db.offRequest.findMany({
    where: { caddyId: actor.caddyId },
    orderBy: [{ date: "desc" }, { id: "desc" }],
  });
}

export async function cancelOwnOffRequest(
  db: PrismaClient,
  actor: OffRequestActor,
  id: number
): Promise<OffRequest> {
  if (actor.caddyId == null) {
    throw new OffRequestServiceError(
      "caddy_not_linked",
      "캐디 계정 연결(caddyId)이 필요합니다.",
      403
    );
  }
  const row = await db.offRequest.findUnique({ where: { id } });
  if (!row) {
    throw new OffRequestServiceError("not_found", "신청을 찾을 수 없습니다.", 404);
  }
  if (!isOwnCaddy(actor, row.caddyId)) {
    throw new OffRequestServiceError("forbidden", "본인 신청만 취소할 수 있습니다.", 403);
  }
  if (!canTransitionOffRequest(row.status, "CANCEL")) {
    throw new OffRequestServiceError(
      "invalid_transition",
      "REQUESTED 상태만 취소할 수 있습니다.",
      409,
      { status: row.status }
    );
  }
  // Assignment 생성 전 단계 — Assignment 없음. row는 CANCELLED로 보존(물리 삭제 금지)
  return db.offRequest.update({
    where: { id },
    data: { status: "CANCELLED" },
  });
}

export type OffRequestListItem = OffRequest & {
  caddy: { id: number; name: string; team: string; teamOrder: number };
};

export async function listOffRequestsForManagers(
  db: DbClient,
  actor: OffRequestActor,
  query: { date: string; team?: string | null; status?: string | null }
): Promise<{ items: OffRequestListItem[]; quotaByTeam: Record<string, OffQuotaSnapshot> }> {
  if (!canManageOffRequests(actor)) {
    throw new OffRequestServiceError("forbidden", "권한이 없습니다.", 403);
  }
  const ymd = query.date;
  normalizeOffDateInput(ymd);
  const filter = resolveTeamFilter(actor, query.team);
  if (!filter.ok) {
    throw new OffRequestServiceError(filter.error, "조 접근 권한이 없습니다.", 403);
  }

  const date = normalizeOffDateInput(ymd);
  const status =
    query.status && ["REQUESTED", "APPROVED", "REJECTED", "CANCELLED"].includes(query.status)
      ? (query.status as OffRequest["status"])
      : undefined;

  const items = await db.offRequest.findMany({
    where: {
      date,
      ...(status ? { status } : {}),
      ...(filter.teams
        ? { caddy: { team: { in: filter.teams } } }
        : {}),
    },
    include: {
      caddy: {
        select: { id: true, name: true, team: true, teamOrder: true },
      },
    },
    orderBy: [{ status: "asc" }, { requestedAt: "asc" }, { id: "asc" }],
  });

  const teams = new Set<string>();
  if (filter.teams) filter.teams.forEach((t) => teams.add(t));
  else items.forEach((i) => teams.add(i.caddy.team));

  const quotaByTeam: Record<string, OffQuotaSnapshot> = {};
  for (const t of teams) {
    quotaByTeam[t] = await getTeamDayQuotaSnapshot(db, t, ymd);
  }

  return { items, quotaByTeam };
}

export async function summarizeOffRequests(
  db: DbClient,
  actor: OffRequestActor,
  query: { date: string; team?: string | null }
): Promise<
  Array<{ team: string; snapshot: OffQuotaSnapshot }>
> {
  if (!canManageOffRequests(actor)) {
    throw new OffRequestServiceError("forbidden", "권한이 없습니다.", 403);
  }
  const ymd = query.date;
  normalizeOffDateInput(ymd);
  const filter = resolveTeamFilter(actor, query.team);
  if (!filter.ok) {
    throw new OffRequestServiceError(filter.error, "조 접근 권한이 없습니다.", 403);
  }

  let teams: string[];
  if (filter.teams) {
    teams = filter.teams;
  } else {
    // admin 전체: 해당일 신청이 있거나 ACTIVE 캐디가 있는 조 — 단순화로 PRIMARY성 조 목록 대신 캐디 distinct team
    const rows = await db.caddy.findMany({
      where: { employmentStatus: "ACTIVE" },
      select: { team: true },
      distinct: ["team"],
      orderBy: { team: "asc" },
    });
    teams = rows.map((r) => r.team).filter(Boolean);
  }

  const out: Array<{ team: string; snapshot: OffQuotaSnapshot }> = [];
  for (const t of teams) {
    out.push({ team: t, snapshot: await getTeamDayQuotaSnapshot(db, t, ymd) });
  }
  return out;
}

export async function approveOffRequest(
  db: PrismaClient,
  actor: OffRequestActor,
  id: number,
  input: { confirmOverQuota?: boolean; decisionNote?: string | null } = {}
): Promise<{ offRequest: OffRequest; quota: OffQuotaSnapshot; overQuotaApproved: boolean }> {
  if (!canManageOffRequests(actor)) {
    throw new OffRequestServiceError("forbidden", "권한이 없습니다.", 403);
  }
  // leader는 managedTeams·감사 추적용 DB User 필요. admin(환경변수 계정)은 userId null 허용.
  if (actor.role === "leader" && actor.userId == null) {
    throw new OffRequestServiceError(
      "user_required",
      "조장 승인에는 DB User 계정이 필요합니다.",
      403
    );
  }

  try {
    return await db.$transaction(async (tx) => {
      const row = await tx.offRequest.findUnique({
        where: { id },
        include: { caddy: { select: { id: true, team: true, name: true } } },
      });
      if (!row) {
        throw new OffRequestServiceError("not_found", "신청을 찾을 수 없습니다.", 404);
      }
      if (!canAccessTeam(actor, row.caddy.team)) {
        throw new OffRequestServiceError("team_forbidden", "해당 조 권한이 없습니다.", 403);
      }
      if (!canTransitionOffRequest(row.status, "APPROVE")) {
        throw new OffRequestServiceError(
          "invalid_transition",
          "REQUESTED 상태만 승인할 수 있습니다.",
          409,
          { status: row.status }
        );
      }

      const ymd = formatOffDateYmd(row.date);
      await assertNoExistingOffAssignment(tx, row.caddyId, ymd);

      const approvedCount = await countApprovedOffForTeamDay(tx, row.caddy.team, ymd);
      const gate = canApproveAgainstQuota({
        approvedCount,
        confirmOverQuota: input.confirmOverQuota,
      });
      if (!gate.ok) {
        throw new OffRequestServiceError(
          "quota_exceeded_confirm_required",
          "조별 승인 정원(5)을 초과합니다. confirmOverQuota=true 로 명시 승인이 필요합니다.",
          409,
          { snapshot: gate.snapshot }
        );
      }

      const { startDate, endDate } = dayBounds(ymd);
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
        decisionNote: input.decisionNote ?? null,
        assignmentId: assignment.id,
      });

      // 동시 승인 레이스: REQUESTED 일 때만 전환. 실패 시 transaction rollback으로 Assignment도 취소.
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

      const updated = await tx.offRequest.findUniqueOrThrow({ where: { id: row.id } });
      const quota = await getTeamDayQuotaSnapshot(tx, row.caddy.team, ymd);
      return {
        offRequest: updated,
        quota,
        overQuotaApproved: gate.requiresConfirm,
      };
    });
  } catch (e) {
    if (e instanceof OffRequestServiceError) throw e;
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === "P2002"
    ) {
      throw new OffRequestServiceError(
        "assignment_conflict",
        "Assignment 생성 충돌이 발생했습니다. 이미 확정 휴무가 있는지 확인하세요.",
        409
      );
    }
    throw e;
  }
}

export async function rejectOffRequest(
  db: PrismaClient,
  actor: OffRequestActor,
  id: number,
  input: { decisionNote?: string | null } = {}
): Promise<OffRequest> {
  if (!canManageOffRequests(actor)) {
    throw new OffRequestServiceError("forbidden", "권한이 없습니다.", 403);
  }
  if (actor.role === "leader" && actor.userId == null) {
    throw new OffRequestServiceError(
      "user_required",
      "조장 반려에는 DB User 계정이 필요합니다.",
      403
    );
  }

  const row = await db.offRequest.findUnique({
    where: { id },
    include: { caddy: { select: { team: true } } },
  });
  if (!row) {
    throw new OffRequestServiceError("not_found", "신청을 찾을 수 없습니다.", 404);
  }
  if (!canAccessTeam(actor, row.caddy.team)) {
    throw new OffRequestServiceError("team_forbidden", "해당 조 권한이 없습니다.", 403);
  }
  if (!canTransitionOffRequest(row.status, "REJECT")) {
    throw new OffRequestServiceError(
      "invalid_transition",
      "REQUESTED 상태만 반려할 수 있습니다.",
      409,
      { status: row.status }
    );
  }

  const decision = applyRejectDecision({
    decidedByUserId: actor.userId,
    decisionNote: input.decisionNote ?? null,
  });

  // Assignment 생성 없음. REQUESTED 조건부 갱신으로 레이스 방지.
  const switched = await db.offRequest.updateMany({
    where: { id, status: "REQUESTED" },
    data: {
      status: decision.status,
      decidedAt: decision.decidedAt as Date,
      decidedByUserId: decision.decidedByUserId,
      decisionNote: decision.decisionNote,
      assignmentId: null,
    },
  });
  if (switched.count !== 1) {
    throw new OffRequestServiceError(
      "invalid_transition",
      "REQUESTED 상태만 반려할 수 있습니다.",
      409
    );
  }
  return db.offRequest.findUniqueOrThrow({ where: { id } });
}

/**
 * 승인 취소: OffRequest에 연결된 Assignment(OFF)만 삭제.
 * 레거시/수동 OFF( OffRequest.assignmentId 미연결 )는 절대 삭제하지 않음.
 */
export async function revokeOffRequest(
  db: PrismaClient,
  actor: OffRequestActor,
  id: number
): Promise<OffRequest> {
  if (!canManageOffRequests(actor)) {
    throw new OffRequestServiceError("forbidden", "권한이 없습니다.", 403);
  }

  return db.$transaction(async (tx) => {
    const row = await tx.offRequest.findUnique({
      where: { id },
      include: { caddy: { select: { team: true } } },
    });
    if (!row) {
      throw new OffRequestServiceError("not_found", "신청을 찾을 수 없습니다.", 404);
    }
    if (!canAccessTeam(actor, row.caddy.team)) {
      throw new OffRequestServiceError("team_forbidden", "해당 조 권한이 없습니다.", 403);
    }
    if (!canTransitionOffRequest(row.status, "REVOKE")) {
      throw new OffRequestServiceError(
        "invalid_transition",
        "APPROVED 상태만 승인 취소할 수 있습니다.",
        409,
        { status: row.status }
      );
    }

    const linkedId = row.assignmentId;
    let deleteAssignmentId: number | null = null;
    if (linkedId != null) {
      const linked = await tx.assignment.findUnique({
        where: { id: linkedId },
        select: { id: true, type: true, caddyId: true },
      });
      // 링크된 OFF만 삭제. 타입/캐디 불일치면 삭제하지 않음(수동 OFF 보호)
      if (linked && linked.type === "OFF" && linked.caddyId === row.caddyId) {
        deleteAssignmentId = linked.id;
      }
    }

    const preserved = applyRevokePreservingApprovalAudit({
      status: row.status,
      decidedAt: row.decidedAt,
      decidedByUserId: row.decidedByUserId,
      decisionNote: row.decisionNote,
      assignmentId: row.assignmentId,
    });

    // 링크 해제 + 상태 전환 후, 연결된 Assignment만 삭제
    const updated = await tx.offRequest.update({
      where: { id: row.id },
      data: {
        status: preserved.status,
        decidedAt: preserved.decidedAt as Date | null,
        decidedByUserId: preserved.decidedByUserId,
        decisionNote: preserved.decisionNote,
        assignmentId: null,
      },
    });

    if (deleteAssignmentId != null) {
      await tx.assignment.delete({ where: { id: deleteAssignmentId } });
    }

    return updated;
  });
}

export function serializeOffRequest(row: OffRequest) {
  return {
    id: row.id,
    caddyId: row.caddyId,
    date: formatOffDateYmd(row.date),
    status: row.status,
    requestedAt: row.requestedAt.toISOString(),
    note: row.note,
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    decidedByUserId: row.decidedByUserId,
    decisionNote: row.decisionNote,
    assignmentId: row.assignmentId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
