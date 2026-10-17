/**
 * 캐디관리 V2 — 조/순번 일괄 재배치 Apply.
 * 하나의 트랜잭션에서 FOR UPDATE → 스냅샷 비교 → 검증 → 배치 UPDATE → Audit.
 * Caddy.team / teamOrder / caddyType / thirdBandSubgroup 만 변경한다.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import { logAudit } from "@/lib/audit";
import { isPrimaryTeam, occupiesHouseThirdSlot, type ThirdBandSubgroup } from "@/lib/caddyManage";
import { findSlotHoldingConflicts } from "@/lib/caddySlot";
import { lockCaddyTableForSlotMutation } from "@/lib/caddySlotLock";
import {
  CADDY_REASSIGN_APPLY_TX_MAX_WAIT_MS,
  CADDY_REASSIGN_APPLY_TX_TIMEOUT_MS,
  CADDY_REASSIGN_AUDIT_ACTION,
  CADDY_REASSIGN_AUDIT_ENTITY,
  CaddyReassignError,
  assertReassignBase,
  buildCaddyReassignLockSql,
  buildCaddyReassignUpdateSql,
  caddyReassignRequestSchema,
  planCaddyReassign,
  throwIfPlanBlocked,
  type CaddyReassignRequest,
  type ReassignBaseRow,
  type ReassignCaddyRow,
  type ReassignChange,
  type ReassignIssue,
  type ReassignMode,
  type ReassignPlacement,
  type ReassignPlan,
} from "@/lib/caddyReassign";

export type ReassignLockedRow = {
  id: number;
  name: string;
  team: string;
  teamOrder: number;
  employmentStatus: string;
  caddyType: string | null;
  thirdBandSubgroup: ThirdBandSubgroup | null;
  updatedAt: Date;
};

export type ReassignTx = {
  $queryRaw: <T = unknown>(query: Prisma.Sql) => Promise<T>;
  $executeRaw: (query: Prisma.Sql) => Promise<number>;
  audit: {
    create: (args: {
      data: Prisma.AuditCreateInput;
    }) => Promise<{ id: number }>;
  };
};

export type ReassignDb = {
  $transaction: <T>(
    fn: (tx: ReassignTx) => Promise<T>,
    options?: { maxWait?: number; timeout?: number }
  ) => Promise<T>;
  caddy?: {
    findMany: (args: unknown) => Promise<ReassignCaddyRow[]>;
  };
};

export type ReassignActor = {
  username?: string | null;
  userId?: number | null;
  ip?: string | null;
};

export type ReassignApplyResult = {
  ok: true;
  updated: number;
  requestedIds: number[];
  affectedIds: number[];
  affectedTeams: string[];
  changes: ReassignChange[];
  auditId: number;
};

const APPLY_TX_OPTIONS = {
  maxWait: CADDY_REASSIGN_APPLY_TX_MAX_WAIT_MS,
  timeout: CADDY_REASSIGN_APPLY_TX_TIMEOUT_MS,
};

function toPlanRow(row: ReassignLockedRow): ReassignCaddyRow {
  return {
    id: row.id,
    name: row.name,
    team: row.team,
    teamOrder: row.teamOrder,
    employmentStatus: row.employmentStatus,
    caddyType: row.caddyType,
    thirdBandSubgroup: row.thirdBandSubgroup,
    updatedAt: row.updatedAt,
  };
}

function parseSubgroup(value: string | null): ThirdBandSubgroup | null {
  if (value === "WEEKDAY" || value === "WEEKEND") return value;
  return null;
}

export function parseCaddyReassignRequest(body: unknown): {
  placements: ReassignPlacement[];
  mode: ReassignMode;
  base?: ReassignBaseRow[];
} {
  const parsed = caddyReassignRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new CaddyReassignError(
      parsed.error.issues[0]?.message || "입력 오류",
      { status: 400, code: "invalid_placement" }
    );
  }
  return {
    placements: parsed.data.placements.map((p) => ({
      id: p.id,
      team: p.team.trim(),
      teamOrder: p.teamOrder,
    })),
    mode: parsed.data.mode,
    base: parsed.data.base,
  };
}

export function previewCaddyReassign(
  rows: ReassignCaddyRow[],
  request: Pick<CaddyReassignRequest, "placements" | "mode">
): ReassignPlan {
  return planCaddyReassign(rows, request.placements, { mode: request.mode });
}

export async function applyCaddyReassign(options: {
  db: ReassignDb | PrismaClient;
  placements: ReassignPlacement[];
  mode: ReassignMode;
  base?: ReassignBaseRow[];
  actor?: ReassignActor;
}): Promise<ReassignApplyResult> {
  const db = options.db as ReassignDb;
  if (typeof db.$transaction !== "function") {
    throw new CaddyReassignError("DB 트랜잭션을 사용할 수 없습니다.", {
      status: 500,
      code: "apply_failed",
    });
  }

  try {
    const result = await db.$transaction(async (tx) => {
      await lockCaddyTableForSlotMutation(tx);
      const lockIds = options.placements.map((p) => p.id);
      const lockedIdsRaw = await tx.$queryRaw<
        Array<{
          id: number;
          name: string;
          team: string;
          teamOrder: number;
          employmentStatus: string;
          caddyType: string | null;
          thirdBandSubgroup: string | null;
          updatedAt: Date;
        }>
      >(buildCaddyReassignLockSql([], lockIds));

      const lockTeams = [
        ...new Set(
          [
            ...lockedIdsRaw.map((row) => String(row.team ?? "").trim()),
            ...options.placements.map((p) => p.team),
          ].filter((team) => isPrimaryTeam(team))
        ),
      ].sort((a, b) => Number(a.replace("조", "")) - Number(b.replace("조", "")));
      const lockedRaw =
        lockTeams.length === 0
          ? lockedIdsRaw
          : await tx.$queryRaw<typeof lockedIdsRaw>(
              buildCaddyReassignLockSql(lockTeams, lockIds)
            );

      const locked: ReassignLockedRow[] = lockedRaw.map((row) => ({
        ...row,
        thirdBandSubgroup: parseSubgroup(row.thirdBandSubgroup),
      }));

      const rows = locked.map(toPlanRow);
      const plan = planCaddyReassign(rows, options.placements, {
        mode: options.mode,
      });
      assertReassignBase(rows, options.base, plan.affectedTeams, plan.requestedIds);
      throwIfPlanBlocked(plan);

      if (plan.patches.length === 0) {
        const audit = await tx.audit.create({
          data: {
            action: CADDY_REASSIGN_AUDIT_ACTION,
            entity: CADDY_REASSIGN_AUDIT_ENTITY,
            entityId: options.placements[0]?.id ?? null,
            ip: options.actor?.ip ?? null,
            payload: {
              updated: 0,
              requestedIds: plan.requestedIds,
              affectedIds: [],
              affectedTeams: plan.affectedTeams,
              changes: [],
              mode: plan.mode,
              username: options.actor?.username ?? null,
              userId: options.actor?.userId ?? null,
            },
          },
        });
        return {
          ok: true as const,
          updated: 0,
          requestedIds: plan.requestedIds,
          affectedIds: [],
          affectedTeams: plan.affectedTeams,
          changes: [],
          auditId: audit.id,
        };
      }

      const updated = await tx.$executeRaw(buildCaddyReassignUpdateSql(plan.patches));
      if (updated !== plan.patches.length) {
        throw new Error(
          `Caddy reassign update count mismatch: expected ${plan.patches.length}, got ${updated}`
        );
      }

      const finalRows = await tx.$queryRaw<
        Array<{
          id: number;
          name: string;
          team: string;
          teamOrder: number;
          employmentStatus: string;
          caddyType: string | null;
        }>
      >(
        Prisma.sql`
          SELECT
            id,
            name,
            team,
            "teamOrder",
            "employmentStatus"::text AS "employmentStatus",
            "caddyType"::text AS "caddyType"
          FROM "Caddy"
          WHERE team IN (${Prisma.join(plan.affectedTeams.length > 0 ? plan.affectedTeams : ["__none__"])})
        `
      );
      const finalConflicts = findSlotHoldingConflicts(
        finalRows
          .filter((row) => occupiesHouseThirdSlot(row))
          .map((row) => ({
            id: row.id,
            name: row.name,
            team: row.team,
            teamOrder: row.teamOrder,
            emp: row.employmentStatus,
            caddyType: row.caddyType,
          }))
      );
      if (finalConflicts.length > 0) {
        const conflict = finalConflicts[0];
        throw new CaddyReassignError(
          `${conflict.team} ${conflict.teamOrder}번 슬롯이 최종 상태에서 중복입니다: ${conflict.names.join(", ")}`,
          {
            status: 409,
            code: "slot_conflict",
            issues: [
              {
                code: "slot_conflict",
                message: `${conflict.team} ${conflict.teamOrder}번 슬롯이 최종 상태에서 중복입니다: ${conflict.names.join(", ")}`,
                team: conflict.team,
                teamOrder: conflict.teamOrder,
                names: conflict.names,
                caddyIds: conflict.ids.filter((id): id is number => id != null),
              },
            ],
          }
        );
      }

      const audit = await tx.audit.create({
        data: {
          action: CADDY_REASSIGN_AUDIT_ACTION,
          entity: CADDY_REASSIGN_AUDIT_ENTITY,
          entityId: plan.requestedIds[0] ?? null,
          ip: options.actor?.ip ?? null,
          payload: {
            updated,
            requestedIds: plan.requestedIds,
            affectedIds: plan.affectedIds,
            affectedTeams: plan.affectedTeams,
            changes: plan.changes,
            mode: plan.mode,
            username: options.actor?.username ?? null,
            userId: options.actor?.userId ?? null,
          },
        },
      });

      return {
        ok: true as const,
        updated,
        requestedIds: plan.requestedIds,
        affectedIds: plan.affectedIds,
        affectedTeams: plan.affectedTeams,
        changes: plan.changes,
        auditId: audit.id,
      };
    }, APPLY_TX_OPTIONS);

    await logAudit({
      action: CADDY_REASSIGN_AUDIT_ACTION,
      meta: {
        entity: CADDY_REASSIGN_AUDIT_ENTITY,
        updated: result.updated,
        requestedIds: result.requestedIds,
        affectedIds: result.affectedIds,
        affectedTeams: result.affectedTeams,
        changes: result.changes,
      },
    });
    return result;
  } catch (e) {
    if (e instanceof CaddyReassignError) throw e;
    console.error("[applyCaddyReassign]", e);
    throw new CaddyReassignError("재배치 저장에 실패했습니다. 데이터가 반영되지 않았습니다.", {
      status: 500,
      code: "apply_failed",
      issues: [
        {
          code: "apply_failed",
          message: "재배치 저장에 실패했습니다. 데이터가 반영되지 않았습니다.",
        },
      ],
    });
  }
}

export function reassignErrorBody(error: CaddyReassignError): {
  error: string;
  code: string;
  issues: ReassignIssue[];
} {
  return {
    error: error.message,
    code: error.code,
    issues: error.issues,
  };
}
