/**
 * 가용 캐디 불러오기 전용 운영배치 Spreadsheet 자동동기화.
 * persist / quick-mutation / reflow / Draft autosave 에서 호출하지 말 것.
 */

import { prisma } from "@/lib/prisma";
import { countByOpsRole } from "@/lib/dailyOpsDuty";
import {
  previewDailyOpsDutyReplace,
  replaceDailyOpsDuties,
  type StoredOpsDutyRow,
} from "@/lib/dailyOpsDutyService";
import {
  fetchPublishedOpsDutySheets,
  OpsDutySheetError,
} from "@/lib/opsDutySheetFetch";
import {
  buildOpsDutySheetSlots,
  isOpsDutySheetAutoApplyReady,
  opsDutySheetApplyBlockReason,
  parseOpsDutySheetsForDate,
  type OpsDutySheetSlot,
} from "@/lib/opsDutySheetParser";

const FETCH_FAIL_CODES = new Set([
  "ops_duty_sheet_error",
  "ops_duty_sheet_empty",
  "ops_duty_sheet_timeout",
  "ops_duty_sheet_fetch_failed",
  "ops_duty_sheet_parse_failed",
]);

export type OpsDutySheetSyncPreview = {
  sheetName?: string;
  matchedCount: number;
  reviewCount: number;
  existingCount: number;
  replaceRequired: boolean;
  canApply: boolean;
  applyBlockReason: string | null;
  error?: string;
  reviews: Array<{ rawName: string; reason: string; role?: string; roleKey?: string }>;
  matched: Array<{ name: string; rawName: string; role: string; roleKey: string }>;
  slots: OpsDutySheetSlot[];
};

export type OpsDutySheetSyncResult = {
  status: "synced" | "review" | "fetch_failed";
  message: string;
  savedCount: number;
  byRole?: Record<string, number>;
  caddyIds: number[];
  preview: OpsDutySheetSyncPreview | null;
};

function emptyPreview(error?: string): OpsDutySheetSyncPreview {
  return {
    matchedCount: 0,
    reviewCount: 0,
    existingCount: 0,
    replaceRequired: false,
    canApply: false,
    applyBlockReason: error || "운영배치 확인 필요",
    error,
    reviews: [],
    matched: [],
    slots: [],
  };
}

function isFetchFailure(error: unknown): boolean {
  if (!(error instanceof OpsDutySheetError)) return false;
  return error.status >= 500 || FETCH_FAIL_CODES.has(error.code);
}

export async function syncOpsDutySheetOnAvailabilityLoad(input: {
  date: string;
  ip?: string | null;
}): Promise<OpsDutySheetSyncResult> {
  let sheets;
  try {
    sheets = await fetchPublishedOpsDutySheets({
      force: true,
      timeoutMs: 15_000,
    });
  } catch (error) {
    return {
      status: "fetch_failed",
      message:
        error instanceof Error
          ? `운영배치 Spreadsheet를 읽지 못해 기존 일정을 유지합니다. (${error.message})`
          : "운영배치 Spreadsheet를 읽지 못해 기존 일정을 유지합니다.",
      savedCount: 0,
      caddyIds: [],
      preview: null,
    };
  }

  try {
    const parsed = parseOpsDutySheetsForDate(sheets, input.date);
    const caddies = await prisma.caddy.findMany({
      select: { id: true, name: true, employmentStatus: true },
    });
    const preview = await previewDailyOpsDutyReplace({
      date: input.date,
      entries: parsed.entries,
      caddies,
    });
    const slots = buildOpsDutySheetSlots({
      entries: parsed.entries,
      matched: preview.matched,
      reviews: preview.reviews,
    });
    const applyBlockReason = opsDutySheetApplyBlockReason({
      matched: preview.matched,
      reviews: preview.reviews,
    });
    const previewPayload: OpsDutySheetSyncPreview = {
      sheetName: parsed.sheetName,
      matchedCount: preview.matched.length,
      reviewCount: preview.reviews.length,
      existingCount: preview.existingCount,
      replaceRequired: preview.existingCount > 0,
      canApply: !applyBlockReason,
      applyBlockReason,
      reviews: preview.reviews,
      matched: preview.matched,
      slots,
    };

    if (
      !isOpsDutySheetAutoApplyReady({
        entries: parsed.entries,
        matched: preview.matched,
        reviews: preview.reviews,
      })
    ) {
      return {
        status: "review",
        message: "운영배치 확인 필요",
        savedCount: 0,
        caddyIds: [],
        preview: previewPayload,
      };
    }

    const saved = await replaceDailyOpsDuties({
      date: input.date,
      matched: preview.matched,
      confirmReplace: true,
      ip: input.ip || null,
    });
    return {
      status: "synced",
      message: `운영배치 ${saved.saved.length}명 동기화`,
      savedCount: saved.saved.length,
      byRole: countByOpsRole(saved.saved),
      caddyIds: [...new Set(saved.saved.map((row: StoredOpsDutyRow) => row.caddyId))],
      preview: previewPayload,
    };
  } catch (error) {
    if (isFetchFailure(error)) {
      return {
        status: "fetch_failed",
        message:
          error instanceof Error
            ? `운영배치 Spreadsheet를 읽지 못해 기존 일정을 유지합니다. (${error.message})`
            : "운영배치 Spreadsheet를 읽지 못해 기존 일정을 유지합니다.",
        savedCount: 0,
        caddyIds: [],
        preview: null,
      };
    }
    if (error instanceof OpsDutySheetError) {
      return {
        status: "review",
        message: "운영배치 확인 필요",
        savedCount: 0,
        caddyIds: [],
        preview: emptyPreview(error.message),
      };
    }
    throw error;
  }
}
