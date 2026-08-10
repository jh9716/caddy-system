/**
 * CONFIRMED 배치표 DB 반영 (Schedule + ShiftDuty + ExtraTag + Audit)
 * - prisma.$transaction 사용, 중간 실패 시 전체 rollback
 * - Production 여부 판별은 호출측 책임 (테스트는 로컬 DB만)
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/prisma";
import {
  buildConfirmPersistPlan,
  validateConfirmRequest,
  type ConfirmIssue,
  type ConfirmPersistPlan,
  type ConfirmRequestBody,
} from "@/lib/assignmentConfirm";

export const AUDIT_ACTION = "ASSIGNMENTS_CONFIRM";
export const AUDIT_ENTITY = "AssignmentConfirm";

export type ConfirmApplySuccess = {
  ok: true;
  status: "APPLIED";
  duplicate: boolean;
  date: string;
  payloadHash: string;
  idempotencyKey: string;
  auditId: number;
  counts: {
    schedules: number;
    shiftDuties: number;
    extraTags: number;
  };
  replaced: boolean;
};

export type ConfirmApplyFailure = {
  ok: false;
  httpStatus: number;
  code: string;
  message: string;
  issues?: ConfirmIssue[];
  existing?: { schedules: number; shiftDuties: number; extraTags: number };
  requireReplace?: boolean;
};

export type ConfirmApplyResult = ConfirmApplySuccess | ConfirmApplyFailure;

export type ApplyOptions = {
  prisma?: PrismaClient;
  ip?: string | null;
  /**
   * 테스트 전용: delete 이후 throw → rollback 검증
   * ALLOW_DB_TEST=1 일 때만 동작
   */
  testThrowAfterDelete?: boolean;
};

type Tx = Prisma.TransactionClient;

function isLocalTestHookAllowed(): boolean {
  return process.env.ALLOW_DB_TEST === "1";
}

async function findDuplicateAudit(
  db: PrismaClient | Tx,
  plan: ConfirmPersistPlan
): Promise<{ id: number } | null> {
  const recent = await db.audit.findMany({
    where: {
      action: AUDIT_ACTION,
      entity: AUDIT_ENTITY,
    },
    orderBy: { id: "desc" },
    take: 50,
    select: { id: true, payload: true },
  });

  for (const row of recent) {
    const p = (row.payload || {}) as Record<string, unknown>;
    if (p.status !== "APPLIED") continue;
    if (p.date !== plan.date) continue;
    if (
      p.payloadHash === plan.payloadHash ||
      p.idempotencyKey === plan.idempotencyKey
    ) {
      return { id: row.id };
    }
  }
  return null;
}

async function countExisting(
  db: PrismaClient | Tx,
  dateObj: Date
): Promise<{ schedules: number; shiftDuties: number; extraTags: number }> {
  const [schedules, shiftDuties, extraTags] = await Promise.all([
    db.schedule.count({ where: { date: dateObj } }),
    db.shiftDuty.count({ where: { date: dateObj } }),
    db.scheduleExtraTag.count({ where: { date: dateObj } }),
  ]);
  return { schedules, shiftDuties, extraTags };
}

async function writePlacement(
  tx: Tx,
  plan: ConfirmPersistPlan,
  opts: {
    replace: boolean;
    ip?: string | null;
    testThrowAfterDelete?: boolean;
  }
): Promise<ConfirmApplySuccess> {
  if (opts.replace) {
    await tx.shiftDuty.deleteMany({ where: { date: plan.dateObj } });
    await tx.schedule.deleteMany({ where: { date: plan.dateObj } });
    await tx.scheduleExtraTag.deleteMany({ where: { date: plan.dateObj } });
  }

  if (
    opts.testThrowAfterDelete &&
    isLocalTestHookAllowed()
  ) {
    throw new Error("TEST_FORCE_ROLLBACK");
  }

  if (plan.schedules.length > 0) {
    await tx.schedule.createMany({ data: plan.schedules });
  }
  if (plan.shiftDuties.length > 0) {
    await tx.shiftDuty.createMany({ data: plan.shiftDuties });
  }
  if (plan.extraTags.length > 0) {
    await tx.scheduleExtraTag.createMany({ data: plan.extraTags });
  }

  const audit = await tx.audit.create({
    data: {
      action: AUDIT_ACTION,
      entity: AUDIT_ENTITY,
      entityId: null,
      ip: opts.ip || null,
      payload: {
        status: "APPLIED",
        date: plan.date,
        payloadHash: plan.payloadHash,
        idempotencyKey: plan.idempotencyKey,
        replaced: opts.replace,
        counts: {
          schedules: plan.schedules.length,
          shiftDuties: plan.shiftDuties.length,
          extraTags: plan.extraTags.length,
        },
        caddyIds: plan.caddyIds,
        assignments: plan.shiftDuties.map((d) => ({
          part: d.part,
          variant: d.variant,
          orderNo: d.orderNo,
          caddyId: d.caddyId,
        })),
      },
    },
  });

  return {
    ok: true,
    status: "APPLIED",
    duplicate: false,
    date: plan.date,
    payloadHash: plan.payloadHash,
    idempotencyKey: plan.idempotencyKey,
    auditId: audit.id,
    counts: {
      schedules: plan.schedules.length,
      shiftDuties: plan.shiftDuties.length,
      extraTags: plan.extraTags.length,
    },
    replaced: opts.replace,
  };
}

/**
 * 서버측 재검증 + transaction write
 */
export async function applyConfirmedAssignments(
  body: unknown,
  options: ApplyOptions = {}
): Promise<ConfirmApplyResult> {
  const db = options.prisma ?? defaultPrisma;
  const parsed = validateConfirmRequest(body);
  if (!parsed.ok) {
    const statusIssue = parsed.issues.find((i) => i.code === "STATUS_NOT_CONFIRMED");
    return {
      ok: false,
      httpStatus: 400,
      code: statusIssue?.code || parsed.issues[0]?.code || "VALIDATION_FAILED",
      message: statusIssue?.message || parsed.issues[0]?.message || "검증 실패",
      issues: parsed.issues,
    };
  }

  const req: ConfirmRequestBody = parsed.value;
  const plan = buildConfirmPersistPlan(req);

  // 없는 caddyId 거부
  const found = await db.caddy.findMany({
    where: { id: { in: plan.caddyIds } },
    select: { id: true },
  });
  const foundSet = new Set(found.map((c) => c.id));
  const missing = plan.caddyIds.filter((id) => !foundSet.has(id));
  if (missing.length > 0) {
    return {
      ok: false,
      httpStatus: 400,
      code: "UNKNOWN_CADDY",
      message: `존재하지 않는 caddyId: ${missing.join(", ")}`,
      issues: missing.map((caddyId) => ({
        code: "UNKNOWN_CADDY",
        message: `caddyId ${caddyId} 없음`,
        caddyId,
      })),
    };
  }

  // 동일 payload 중복 저장 방지
  const dup = await findDuplicateAudit(db, plan);
  if (dup) {
    return {
      ok: true,
      status: "APPLIED",
      duplicate: true,
      date: plan.date,
      payloadHash: plan.payloadHash,
      idempotencyKey: plan.idempotencyKey,
      auditId: dup.id,
      counts: {
        schedules: plan.schedules.length,
        shiftDuties: plan.shiftDuties.length,
        extraTags: plan.extraTags.length,
      },
      replaced: false,
    };
  }

  const existing = await countExisting(db, plan.dateObj);
  const hasExisting =
    existing.schedules > 0 ||
    existing.shiftDuties > 0 ||
    existing.extraTags > 0;

  if (hasExisting && !req.replace) {
    return {
      ok: false,
      httpStatus: 409,
      code: "EXISTING_PLACEMENTS",
      message:
        "같은 날짜에 기존 배치가 있습니다. 덮어쓰려면 replace: true (관리자 명시 승인)가 필요합니다.",
      existing,
      requireReplace: true,
    };
  }

  try {
    const result = await db.$transaction(async (tx) =>
      writePlacement(tx, plan, {
        replace: Boolean(req.replace) && hasExisting,
        ip: options.ip,
        testThrowAfterDelete: options.testThrowAfterDelete,
      })
    );
    return result;
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "transaction 실패";
    if (message === "TEST_FORCE_ROLLBACK") {
      return {
        ok: false,
        httpStatus: 500,
        code: "TEST_FORCE_ROLLBACK",
        message,
      };
    }
    console.error("[applyConfirmedAssignments]", e);
    return {
      ok: false,
      httpStatus: 500,
      code: "TRANSACTION_FAILED",
      message: "배치 저장 중 오류가 발생하여 전체가 롤백되었습니다.",
    };
  }
}
