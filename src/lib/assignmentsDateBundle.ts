/**
 * /manage/assignments 날짜 1회 load용 in-process aggregate.
 * 기존 /api/* route를 HTTP로 체이닝하지 않는다.
 * Sheet freshness / cache / inflight 정책은 변경하지 않는다.
 */

import { prisma } from "@/lib/prisma";
import { parseYmd } from "@/lib/availabilityEngine";
import { shouldApplyAssignmentsDateBundle } from "@/lib/assignmentsDateBundleView";
import { parseUnavailableFromShift } from "@/lib/caddyPoolCanonical";
import {
  loadAvailabilityForDate,
  type AvailabilityWithSlotGrid,
} from "@/lib/availabilityService";
import {
  getDailyBoardDraft,
  mapUnavailablePanelRows,
  type DailyBoardDraftRecord,
  type UnavailablePanelSourceRow,
} from "@/lib/dailyBoardDraftService";
import type { UnavailableFromShiftRow } from "@/lib/autoAssignEngine";
import {
  getDailyBoardPublished,
  type DailyBoardPublishedRecord,
} from "@/lib/dailyBoardPublishedService";
import { listDailyOffOverrides } from "@/lib/offEffectiveService";
import {
  DailyOpsDutyError,
  listDailyOpsDuties,
} from "@/lib/dailyOpsDutyService";
import {
  listDailyOpsDutyOverrides,
  type StoredOpsDutyOverrideRow,
} from "@/lib/opsDutyEffectiveService";
import {
  opsDutyPanelRowsFromReadOnly,
  resolveOpsDutyReadOnly,
} from "@/lib/opsDutyReadOnlySource";
import { buildOpsDutySlotStates } from "@/lib/opsDutyEffective";
import { countByOpsRole } from "@/lib/dailyOpsDuty";
import {
  resolveThirdWeeklyStart,
  ThirdWeeklyStartError,
} from "@/lib/thirdWeeklyStartService";
import {
  buildDailySpecialDutyPayload,
  DailySpecialDutyError,
} from "@/lib/dailySpecialDutyService";
import {
  buildDailySpecialSupportPayload,
  DailySpecialSupportError,
} from "@/lib/dailySpecialSupportService";
import {
  BoardPushError,
  isBoardPushStoreMissing,
  previewBoardPush,
  type BoardPushPreview,
} from "@/lib/boardPush";
import { OffSheetError } from "@/lib/offSheetFetch";
import { DutyExcelError } from "@/lib/dutyMarshalLeaderParser";
import { DailyBoardDraftPayloadError } from "@/lib/dailyBoardDraft";
import { DailyBoardPublishedPayloadError } from "@/lib/dailyBoardPublished";

export const ASSIGNMENTS_DATE_BUNDLE_SECTIONS = [
  "draft",
  "availability",
  "opsDuty",
  "offOverrides",
  "unavailables",
  "thirdWeeklyStart",
  "published",
  "specialDuties",
  "specialSupports",
  "boardPreview",
] as const;

export type AssignmentsDateBundleSection =
  (typeof ASSIGNMENTS_DATE_BUNDLE_SECTIONS)[number];

export type AssignmentsDateBundleSectionError = {
  error: string;
  code?: string;
};

export type AssignmentsDateBundleDraft = {
  draft: DailyBoardDraftRecord | null;
  unavailableCaddyIds: number[];
  unavailableFromShift: UnavailableFromShiftRow[];
  unavailableRows: UnavailablePanelSourceRow[];
};

export type AssignmentsDateBundlePublishedMeta = {
  sourceDraftVersion: number;
  publishedAt: string;
  publishedByUsername: string | null;
};

export type AssignmentsDateBundleOpsDuty = {
  date: string;
  source: string;
  persisted: boolean;
  count: number;
  byRole: ReturnType<typeof countByOpsRole>;
  caddyIds: number[];
  rows: ReturnType<typeof opsDutyPanelRowsFromReadOnly>;
  error: string | null;
  slots?: ReturnType<typeof buildOpsDutySlotStates>;
};

export type AssignmentsDateBundlePayload = {
  ok: true;
  date: string;
  draft: AssignmentsDateBundleDraft | null;
  availability: AvailabilityWithSlotGrid | null;
  opsDuty: AssignmentsDateBundleOpsDuty | null;
  offOverrides: {
    date: string;
    count: number;
    overrides: Array<{
      caddyId: number;
      action: string;
      name: string;
      team: string;
    }>;
  } | null;
  unavailables: {
    date: string;
    count: number;
    rows: UnavailablePanelSourceRow[];
  } | null;
  thirdWeeklyStart: Awaited<ReturnType<typeof resolveThirdWeeklyStart>> | null;
  published: AssignmentsDateBundlePublishedMeta | null;
  specialDuties: Awaited<ReturnType<typeof buildDailySpecialDutyPayload>> | null;
  specialSupports: Awaited<
    ReturnType<typeof buildDailySpecialSupportPayload>
  > | null;
  boardPreview: BoardPushPreview | null;
  errors: Partial<
    Record<AssignmentsDateBundleSection, AssignmentsDateBundleSectionError>
  >;
  timings: Record<string, number>;
  queryCounts: AssignmentsDateReadQueryCounts;
};

export type AssignmentsDateReadQueryCounts = {
  caddyFindMany: number;
  dailyCaddyUnavailable: number;
  dailyOffOverride: number;
  dailyOpsDuty: number;
  dailyOpsDutyOverride: number;
  dailyBoardDraft: number;
  dailyBoardPublished: number;
};

type UnavailableRawRow = {
  caddyId: number;
  reason: string;
  effectiveFromShift?: string | null;
  caddy?: {
    name?: string | null;
    team?: string | null;
    employmentStatus?: string | null;
  } | null;
};

export type AssignmentsDateReadContext = {
  date: string;
  queryCounts: AssignmentsDateReadQueryCounts;
  listCaddies: () => Promise<
    Array<{
      id: number;
      name: string;
      team: string;
      teamOrder: number;
      employmentStatus: string;
      caddyType: string;
      extraFlags: string[];
      thirdBandSubgroup: string | null;
    }>
  >;
  listOffOverrides: () => ReturnType<typeof listDailyOffOverrides>;
  listUnavailablePanelRows: () => Promise<UnavailablePanelSourceRow[]>;
  listUnavailableFromShift: () => Promise<UnavailableFromShiftRow[]>;
  listOpsDuties: () => ReturnType<typeof listDailyOpsDuties>;
  listOpsDutyOverrides: () => Promise<StoredOpsDutyOverrideRow[]>;
  getDraft: () => Promise<DailyBoardDraftRecord | null>;
  getPublished: () => Promise<DailyBoardPublishedRecord | null>;
};

function emptyQueryCounts(): AssignmentsDateReadQueryCounts {
  return {
    caddyFindMany: 0,
    dailyCaddyUnavailable: 0,
    dailyOffOverride: 0,
    dailyOpsDuty: 0,
    dailyOpsDutyOverride: 0,
    dailyBoardDraft: 0,
    dailyBoardPublished: 0,
  };
}

function dateKey(ymd: string): Date {
  return parseYmd(ymd).start;
}


function mapUnavailableFromShift(
  rows: UnavailableRawRow[]
): UnavailableFromShiftRow[] {
  return rows
    .map((row) => ({
      caddyId: Number(row.caddyId),
      effectiveFromShift: parseUnavailableFromShift(row.effectiveFromShift),
    }))
    .filter((row) => Number.isInteger(row.caddyId) && row.caddyId > 0);
}

export function createAssignmentsDateReadContext(
  ymd: string
): AssignmentsDateReadContext {
  const queryCounts = emptyQueryCounts();
  let caddiesP: ReturnType<AssignmentsDateReadContext["listCaddies"]> | null =
    null;
  let offOverridesP: ReturnType<typeof listDailyOffOverrides> | null = null;
  let unavailRawP: Promise<UnavailableRawRow[]> | null = null;
  let opsDutiesP: ReturnType<typeof listDailyOpsDuties> | null = null;
  let opsOverridesP: Promise<StoredOpsDutyOverrideRow[]> | null = null;
  let draftP: Promise<DailyBoardDraftRecord | null> | null = null;
  let publishedP: Promise<DailyBoardPublishedRecord | null> | null = null;

  const loadUnavailRaw = () => {
    if (!unavailRawP) {
      queryCounts.dailyCaddyUnavailable += 1;
      unavailRawP = prisma.dailyCaddyUnavailable.findMany({
        where: { date: dateKey(ymd) },
        select: {
          caddyId: true,
          reason: true,
          effectiveFromShift: true,
          caddy: { select: { name: true, team: true, employmentStatus: true } },
        },
      });
    }
    return unavailRawP;
  };

  return {
    date: ymd,
    queryCounts,
    listCaddies() {
      if (!caddiesP) {
        queryCounts.caddyFindMany += 1;
        caddiesP = prisma.caddy.findMany({
          select: {
            id: true,
            name: true,
            team: true,
            teamOrder: true,
            employmentStatus: true,
            caddyType: true,
            extraFlags: true,
            thirdBandSubgroup: true,
          },
          orderBy: [{ team: "asc" }, { teamOrder: "asc" }, { id: "asc" }],
        });
      }
      return caddiesP;
    },
    listOffOverrides() {
      if (!offOverridesP) {
        queryCounts.dailyOffOverride += 1;
        offOverridesP = listDailyOffOverrides(ymd);
      }
      return offOverridesP;
    },
    async listUnavailablePanelRows() {
      return mapUnavailablePanelRows(await loadUnavailRaw());
    },
    async listUnavailableFromShift() {
      return mapUnavailableFromShift(await loadUnavailRaw());
    },
    listOpsDuties() {
      if (!opsDutiesP) {
        queryCounts.dailyOpsDuty += 1;
        opsDutiesP = listDailyOpsDuties(ymd);
      }
      return opsDutiesP;
    },
    listOpsDutyOverrides() {
      if (!opsOverridesP) {
        queryCounts.dailyOpsDutyOverride += 1;
        opsOverridesP = listDailyOpsDutyOverrides(ymd);
      }
      return opsOverridesP;
    },
    getDraft() {
      if (!draftP) {
        queryCounts.dailyBoardDraft += 1;
        draftP = getDailyBoardDraft(ymd);
      }
      return draftP;
    },
    getPublished() {
      if (!publishedP) {
        queryCounts.dailyBoardPublished += 1;
        publishedP = getDailyBoardPublished(ymd);
      }
      return publishedP;
    },
  };
}

export { shouldApplyAssignmentsDateBundle } from "@/lib/assignmentsDateBundleView";

export function publishedMetadataFromRecord(
  published: DailyBoardPublishedRecord | null
): AssignmentsDateBundlePublishedMeta | null {
  if (!published) return null;
  return {
    sourceDraftVersion: published.sourceDraftVersion,
    publishedAt: published.publishedAt,
    publishedByUsername: published.payload.publisherUsername ?? null,
  };
}

function sectionError(
  e: unknown,
  fallback: string
): AssignmentsDateBundleSectionError {
  if (
    e instanceof OffSheetError ||
    e instanceof DutyExcelError ||
    e instanceof DailyOpsDutyError ||
    e instanceof ThirdWeeklyStartError ||
    e instanceof DailySpecialDutyError ||
    e instanceof DailySpecialSupportError ||
    e instanceof BoardPushError ||
    e instanceof DailyBoardDraftPayloadError ||
    e instanceof DailyBoardPublishedPayloadError
  ) {
    return { error: e.message, code: e.code };
  }
  if (isBoardPushStoreMissing(e)) {
    return { error: "push_store_unavailable", code: "push_store_unavailable" };
  }
  return { error: e instanceof Error ? e.message : fallback };
}

async function timed<T>(
  timings: Record<string, number>,
  key: string,
  work: () => Promise<T>
): Promise<T> {
  const started = Date.now();
  try {
    return await work();
  } finally {
    timings[key] = Date.now() - started;
  }
}

export type AssignmentsDateBundleLoaders = {
  loadAvailability?: typeof loadAvailabilityForDate;
  resolveOpsDuty?: typeof resolveOpsDutyReadOnly;
  resolveThirdWeekly?: typeof resolveThirdWeeklyStart;
  buildSpecialDuties?: typeof buildDailySpecialDutyPayload;
  buildSpecialSupports?: typeof buildDailySpecialSupportPayload;
  previewPush?: typeof previewBoardPush;
};

export async function loadAssignmentsDateBundle(
  ymd: string,
  ctx: AssignmentsDateReadContext = createAssignmentsDateReadContext(ymd),
  loaders: AssignmentsDateBundleLoaders = {}
): Promise<AssignmentsDateBundlePayload> {
  parseYmd(ymd);
  const started = Date.now();
  const timings: Record<string, number> = {};
  const errors: AssignmentsDateBundlePayload["errors"] = {};
  const loadAvailability = loaders.loadAvailability ?? loadAvailabilityForDate;
  const resolveOpsDuty = loaders.resolveOpsDuty ?? resolveOpsDutyReadOnly;
  const resolveThirdWeekly = loaders.resolveThirdWeekly ?? resolveThirdWeeklyStart;
  const buildSpecialDuties =
    loaders.buildSpecialDuties ?? buildDailySpecialDutyPayload;
  const buildSpecialSupports =
    loaders.buildSpecialSupports ?? buildDailySpecialSupportPayload;
  const previewPush = loaders.previewPush ?? previewBoardPush;

  const draftP = timed(timings, "draftMs", async () => {
    const [draft, unavailableFromShift, unavailableRows] = await Promise.all([
      ctx.getDraft(),
      ctx.listUnavailableFromShift(),
      ctx.listUnavailablePanelRows(),
    ]);
    return {
      draft,
      unavailableCaddyIds: unavailableFromShift.map((row) => row.caddyId),
      unavailableFromShift,
      unavailableRows,
    } satisfies AssignmentsDateBundleDraft;
  });

  const availabilityP = timed(timings, "availabilityMs", () =>
    loadAvailability(ymd, {
      listCaddies: () => ctx.listCaddies(),
      listOffOverrides: () => ctx.listOffOverrides(),
      listUnavailables: () => ctx.listUnavailablePanelRows(),
      opsDutyDeps: {
        listDuties: () => ctx.listOpsDuties(),
        listOverrides: () => ctx.listOpsDutyOverrides(),
        listCaddies: () => ctx.listCaddies(),
      },
    })
  );

  const opsDutyP = timed(timings, "opsDutyMs", async () => {
    const resolved = await resolveOpsDuty(ymd, {
      listDuties: () => ctx.listOpsDuties(),
    });
    const [caddies, overrides] = await Promise.all([
      ctx.listCaddies(),
      ctx.listOpsDutyOverrides(),
    ]);
    const rows = opsDutyPanelRowsFromReadOnly(resolved, caddies);
    const payload: AssignmentsDateBundleOpsDuty = {
      date: ymd,
      source: resolved.source,
      persisted: resolved.source === "stored",
      count: rows.length,
      byRole: countByOpsRole(rows),
      caddyIds: [...new Set(rows.map((row) => row.caddyId))],
      rows,
      error: resolved.error,
    };
    try {
      payload.slots = buildOpsDutySlotStates(rows, overrides);
    } catch (overlayError) {
      console.error(
        "[assignments-date-bundle] overlay slots skipped",
        overlayError
      );
    }
    return payload;
  });

  const offOverridesP = timed(timings, "offOverridesMs", async () => {
    const overrides = await ctx.listOffOverrides();
    return {
      date: ymd,
      count: overrides.length,
      overrides: overrides.map((row) => ({
        caddyId: row.caddyId,
        action: row.action,
        name: row.name,
        team: row.team,
      })),
    };
  });

  const unavailablesP = timed(timings, "unavailablesMs", async () => {
    const rows = await ctx.listUnavailablePanelRows();
    return { date: ymd, count: rows.length, rows };
  });

  const thirdWeeklyP = timed(timings, "thirdWeeklyStartMs", () =>
    resolveThirdWeekly(ymd)
  );
  const publishedP = timed(timings, "publishedMs", () => ctx.getPublished());
  const specialDutiesP = timed(timings, "specialDutiesMs", async () => {
    const caddies = await ctx.listCaddies();
    return buildSpecialDuties(ymd, { caddies });
  });
  const specialSupportsP = timed(timings, "specialSupportsMs", () =>
    buildSpecialSupports(ymd)
  );

  const boardPreviewP = timed(timings, "boardPreviewMs", async () => {
    const [published, draft] = await Promise.all([
      ctx.getPublished(),
      ctx.getDraft(),
    ]);
    return previewPush(prisma, ymd, {
      published,
      currentDraftVersion: draft?.version ?? null,
    });
  });

  const settled = await Promise.all([
    draftP.then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error })
    ),
    availabilityP.then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error })
    ),
    opsDutyP.then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error })
    ),
    offOverridesP.then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error })
    ),
    unavailablesP.then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error })
    ),
    thirdWeeklyP.then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error })
    ),
    publishedP.then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error })
    ),
    specialDutiesP.then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error })
    ),
    specialSupportsP.then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error })
    ),
    boardPreviewP.then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error })
    ),
  ]);

  const [
    draftResult,
    availabilityResult,
    opsDutyResult,
    offOverridesResult,
    unavailablesResult,
    thirdWeeklyResult,
    publishedResult,
    specialDutiesResult,
    specialSupportsResult,
    boardPreviewResult,
  ] = settled;

  if (!draftResult.ok) {
    throw draftResult.error;
  }

  if (!availabilityResult.ok) {
    errors.availability = sectionError(
      availabilityResult.error,
      "가용 계산 실패"
    );
  }
  if (!opsDutyResult.ok) {
    errors.opsDuty = sectionError(opsDutyResult.error, "당번 일정 조회 실패");
  }
  if (!offOverridesResult.ok) {
    errors.offOverrides = sectionError(
      offOverridesResult.error,
      "휴무 overlay 조회 실패"
    );
  }
  if (!unavailablesResult.ok) {
    errors.unavailables = sectionError(
      unavailablesResult.error,
      "병가/결근 조회 실패"
    );
  }
  if (!thirdWeeklyResult.ok) {
    errors.thirdWeeklyStart = sectionError(
      thirdWeeklyResult.error,
      "3부반 시작조 처리 실패"
    );
  }
  if (!publishedResult.ok) {
    errors.published = sectionError(
      publishedResult.error,
      "배치표 조회 실패"
    );
  }
  if (!specialDutiesResult.ok) {
    errors.specialDuties = sectionError(
      specialDutiesResult.error,
      "특수근무 처리 실패"
    );
  }
  if (!specialSupportsResult.ok) {
    errors.specialSupports = sectionError(
      specialSupportsResult.error,
      "특수지원 처리 실패"
    );
  }
  if (!boardPreviewResult.ok) {
    errors.boardPreview = sectionError(
      boardPreviewResult.error,
      "미리보기 실패"
    );
  }

  timings.totalMs = Date.now() - started;

  return {
    ok: true,
    date: ymd,
    draft: draftResult.value,
    availability: availabilityResult.ok ? availabilityResult.value : null,
    opsDuty: opsDutyResult.ok ? opsDutyResult.value : null,
    offOverrides: offOverridesResult.ok ? offOverridesResult.value : null,
    unavailables: unavailablesResult.ok ? unavailablesResult.value : null,
    thirdWeeklyStart: thirdWeeklyResult.ok ? thirdWeeklyResult.value : null,
    published: publishedResult.ok
      ? publishedMetadataFromRecord(publishedResult.value)
      : null,
    specialDuties: specialDutiesResult.ok ? specialDutiesResult.value : null,
    specialSupports: specialSupportsResult.ok
      ? specialSupportsResult.value
      : null,
    boardPreview: boardPreviewResult.ok ? boardPreviewResult.value : null,
    errors,
    timings,
    queryCounts: ctx.queryCounts,
  };
}
