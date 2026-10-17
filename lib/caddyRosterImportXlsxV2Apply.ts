/**
 * 캐디 명단 V2 workbook apply.
 * P2 preview와 같은 parser/plan을 다시 돌린 뒤 한 transaction으로만 반영한다.
 * Production write 금지. 호출부는 local DB / mock 만.
 */

import {
  incrementSessionVersionForCaddyLink,
  employmentBecameRetired,
  type SessionRevocationDb,
} from "../src/lib/sessionRevocation";
import { lockCaddyTableForSlotMutation } from "../src/lib/caddySlotLock";
import { notifyChatSessionRevokedForCaddyLink } from "../src/lib/chatSessionRevoke";
import {
  buildXlsxV2PreviewBundle,
  fingerprintRosterSnapshot,
  type XlsxV2ApplyPlan,
  type XlsxV2CaddyPatch,
  type XlsxV2PreviewExisting,
  type XlsxV2PreviewOptions,
  type XlsxV2WorkbookPreview,
} from "./caddyRosterImportXlsxV2Preview";

export const XLSX_V2_APPLY_SOURCE = "xlsx_v2";

export class XlsxV2ApplyError extends Error {
  status: number;
  code: string;
  preview?: XlsxV2WorkbookPreview;
  constructor(
    message: string,
    status: number,
    code: string,
    preview?: XlsxV2WorkbookPreview
  ) {
    super(message);
    this.name = "XlsxV2ApplyError";
    this.status = status;
    this.code = code;
    this.preview = preview;
  }
}

export type XlsxV2ApplyDb = {
  $transaction: <T>(
    fn: (tx: XlsxV2ApplyTx) => Promise<T>,
    options?: { timeout?: number; maxWait?: number }
  ) => Promise<T>;
};

export type XlsxV2ApplyTx = {
  $executeRaw: (query: unknown) => Promise<unknown>;
  caddy: {
    findMany: (args: unknown) => Promise<XlsxV2PreviewExisting[]>;
    update: (args: {
      where: { id: number };
      data: Record<string, unknown>;
    }) => Promise<unknown>;
    create: (args: { data: Record<string, unknown> }) => Promise<{ id: number }>;
  };
  user: {
    updateMany: (args: {
      where: { caddyId: number };
      data: { sessionVersion: { increment: number } };
    }) => Promise<{ count: number }>;
  };
  audit: {
    create: (args: { data: Record<string, unknown> }) => Promise<{ id: number }>;
  };
};

export type XlsxV2ApplyResult = {
  ok: true;
  created: number;
  updated: number;
  retired: number;
  drivingChanged: number;
  sessionsRevoked: number;
  createdIds: number[];
  updatedIds: number[];
  retiredIds: number[];
  drivingIds: number[];
  auditId: number | null;
  fingerprint: string;
};

const CADDY_SELECT = {
  id: true,
  name: true,
  team: true,
  teamOrder: true,
  employmentStatus: true,
  phoneNormalized: true,
  thirdBandSubgroup: true,
  caddyType: true,
} as const;

function asExisting(rows: XlsxV2PreviewExisting[]): XlsxV2PreviewExisting[] {
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    team: row.team,
    teamOrder: Number(row.teamOrder) || 0,
    employmentStatus: String(row.employmentStatus),
    phoneNormalized: row.phoneNormalized ?? null,
    thirdBandSubgroup: row.thirdBandSubgroup ?? null,
    caddyType: row.caddyType ?? null,
  }));
}

function patchToData(patch: XlsxV2CaddyPatch): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  if (patch.name !== undefined) data.name = patch.name;
  if (patch.team !== undefined) data.team = patch.team;
  if (patch.teamOrder !== undefined) data.teamOrder = patch.teamOrder;
  if (patch.employmentStatus !== undefined) {
    data.employmentStatus = patch.employmentStatus;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "phoneNormalized")) {
    data.phoneNormalized = patch.phoneNormalized ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "thirdBandSubgroup")) {
    data.thirdBandSubgroup = patch.thirdBandSubgroup ?? null;
  }
  if (patch.caddyType !== undefined) data.caddyType = patch.caddyType;
  return data;
}

function planHasWork(plan: XlsxV2ApplyPlan): boolean {
  return (
    plan.updates.length +
      plan.creates.length +
      plan.retires.length +
      plan.driving.length >
    0
  );
}

export async function applyXlsxV2Workbook(
  input: {
    buffer: Buffer;
    fingerprint: string;
    canReadArchived: boolean;
    actorUserId: number | null;
  },
  db: XlsxV2ApplyDb
): Promise<XlsxV2ApplyResult> {
  if (!input.fingerprint || !/^[a-f0-9]{64}$/i.test(input.fingerprint)) {
    throw new XlsxV2ApplyError(
      "미리보기 확인값(fingerprint)이 필요합니다.",
      400,
      "fingerprint_required"
    );
  }

  const revokedCaddyIds: number[] = [];
  const result = await db.$transaction(async (tx) => {
    await lockCaddyTableForSlotMutation(tx);
    const live = asExisting(
      await tx.caddy.findMany({
        select: CADDY_SELECT,
        orderBy: [{ team: "asc" }, { teamOrder: "asc" }, { id: "asc" }],
      })
    );
    const liveFingerprint = fingerprintRosterSnapshot(live);
    if (liveFingerprint !== input.fingerprint) {
      throw new XlsxV2ApplyError(
        "명단이 미리보기 이후 변경되었습니다. 다시 미리보기하세요.",
        409,
        "stale_preview"
      );
    }

    const options: XlsxV2PreviewOptions = {
      canReadArchived: input.canReadArchived,
    };
    const { preview, plan } = buildXlsxV2PreviewBundle(
      input.buffer,
      live,
      options
    );
    if (preview.errors.length > 0) {
      throw new XlsxV2ApplyError(
        "검증 오류가 있어 적용하지 않았습니다.",
        400,
        "preview_errors",
        preview
      );
    }
    if (!planHasWork(plan) || !preview.summary.applyAvailable) {
      throw new XlsxV2ApplyError(
        "적용할 변경이 없습니다.",
        400,
        "nothing_to_apply",
        preview
      );
    }

    const updatedIds: number[] = [];
    const retiredIds: number[] = [];
    const drivingIds: number[] = [];
    const createdIds: number[] = [];
    let sessionsRevoked = 0;

    for (const patch of plan.updates) {
      const data = patchToData(patch);
      if (Object.keys(data).length === 0) continue;
      await tx.caddy.update({ where: { id: patch.id }, data });
      updatedIds.push(patch.id);
      if (
        employmentBecameRetired(
          live.find((r) => r.id === patch.id)?.employmentStatus,
          patch.employmentStatus
        )
      ) {
        sessionsRevoked += await incrementSessionVersionForCaddyLink(
          tx as SessionRevocationDb,
          patch.id
        );
        revokedCaddyIds.push(patch.id);
      }
    }

    for (const patch of plan.driving) {
      const data = patchToData(patch);
      if (Object.keys(data).length === 0) continue;
      await tx.caddy.update({ where: { id: patch.id }, data });
      drivingIds.push(patch.id);
      if (
        employmentBecameRetired(
          live.find((r) => r.id === patch.id)?.employmentStatus,
          patch.employmentStatus
        )
      ) {
        sessionsRevoked += await incrementSessionVersionForCaddyLink(
          tx as SessionRevocationDb,
          patch.id
        );
        revokedCaddyIds.push(patch.id);
      }
    }

    for (const retire of plan.retires) {
      await tx.caddy.update({
        where: { id: retire.id },
        data: { employmentStatus: "RETIRED" },
      });
      retiredIds.push(retire.id);
      if (employmentBecameRetired(retire.previousEmployment, "RETIRED")) {
        sessionsRevoked += await incrementSessionVersionForCaddyLink(
          tx as SessionRevocationDb,
          retire.id
        );
        revokedCaddyIds.push(retire.id);
      }
    }

    for (const create of plan.creates) {
      const created = await tx.caddy.create({
        data: {
          name: create.name,
          team: create.team,
          teamOrder: create.teamOrder,
          employmentStatus: create.employmentStatus,
          phoneNormalized: create.phone,
          thirdBandSubgroup: create.thirdBandSubgroup,
          caddyType: create.caddyType,
        },
      });
      createdIds.push(created.id);
    }

    const audit = await tx.audit.create({
      data: {
        action: "IMPORT_CADDIES_XLSX_V2",
        entity: "Caddy",
        entityId: input.actorUserId,
        payload: {
          source: XLSX_V2_APPLY_SOURCE,
          actorUserId: input.actorUserId,
          created: createdIds.length,
          updated: updatedIds.length,
          retired: retiredIds.length,
          drivingChanged: drivingIds.length,
          createdIds,
          updatedIds,
          retiredIds,
          drivingIds,
          fingerprint: liveFingerprint,
        },
      },
    });

    return {
      ok: true as const,
      created: createdIds.length,
      updated: updatedIds.length,
      retired: retiredIds.length,
      drivingChanged: drivingIds.length,
      sessionsRevoked,
      createdIds,
      updatedIds,
      retiredIds,
      drivingIds,
      auditId: audit?.id ?? null,
      fingerprint: liveFingerprint,
    };
  }, { timeout: 60_000, maxWait: 10_000 });
  for (const caddyId of revokedCaddyIds) {
    await notifyChatSessionRevokedForCaddyLink(
      db as {
        user: {
          findMany: (args: {
            where: { caddyId: number };
            select: { id: true; sessionVersion: true };
          }) => Promise<Array<{ id: number; sessionVersion: number }>>;
        };
      },
      caddyId
    );
  }
  return result;
}

export function xlsxV2ApplySuccessMessage(result: XlsxV2ApplyResult): string {
  return `명단 반영 완료: 신규 ${result.created} · 수정 ${result.updated} · 퇴사 ${result.retired} · 드라이빙 ${result.drivingChanged}`;
}
