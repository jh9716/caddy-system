/**
 * 가용 엔진용 DB 로더 (읽기 전용 SELECT)
 * Production 데이터 수정 없음.
 */
import { prisma } from "@/lib/prisma";
import {
  computeAvailability,
  parseYmd,
} from "@/lib/availabilityEngine";
import {
  buildTeamSlotGrid,
  type TeamSlotGrid,
} from "@/lib/availabilitySlotGrid";
import {
  applyDailyExternalExclusions,
  type DailyAvailabilityResult,
} from "@/lib/dailyAvailabilityOverlay";
import {
  fetchPublishedOffSheets,
  rememberOffSheetsForDate,
  requireOffNamesForDate,
} from "@/lib/offSheetFetch";
import type { OffSheet } from "@/lib/offSheetParser";
import {
  parseDutyMarshalLeaderWorkbook,
  type DutyExcelEntry,
} from "@/lib/dutyMarshalLeaderParser";
import { loadStoredDutyEntries } from "@/lib/dailyOpsDutyService";

export type AvailabilityWithSlotGrid = DailyAvailabilityResult & {
  slotGrid: TeamSlotGrid;
  dutySource?: "file" | "stored" | "none";
  dutyEntryCount?: number;
};

export type LoadAvailabilityOptions = {
  /** 테스트/미리 읽은 시트. 없으면 운영 Sheet를 fetch */
  offSheets?: OffSheet[];
  /** 당번·마샬·조장 파일 버퍼. 있으면 이번 요청 overlay에만 사용(미리보기). 저장은 별도 apply. */
  dutyWorkbook?: Buffer | ArrayBuffer | Uint8Array | null;
  /** 이미 파싱된 당번·마샬·조장. workbook보다 우선하지 않음. 저장/apply 없음. */
  dutyEntries?: DutyExcelEntry[];
  /** false면 저장된 당번·마샬·조장 일정을 읽지 않음 (기본 true) */
  includeStoredOpsDuty?: boolean;
  /** false면 휴무 Sheet를 읽지 않음 (기본 true) */
  includeOffSheet?: boolean;
  /** true면 휴무 Sheet 캐시를 무시하고 다시 읽음 (가용 새로고침) */
  forceOffSheet?: boolean;
};

export async function loadAvailabilityForDate(
  ymd: string,
  options?: LoadAvailabilityOptions
): Promise<AvailabilityWithSlotGrid> {
  parseYmd(ymd); // validate early
  const { start, end } = parseYmd(ymd);

  const [caddies, assignments, extraTags] = await Promise.all([
    prisma.caddy.findMany({
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
    }),
    prisma.assignment.findMany({
      where: {
        startDate: { lte: end },
        endDate: { gte: start },
      },
      select: {
        caddyId: true,
        type: true,
        subType: true,
        startDate: true,
        endDate: true,
      },
    }),
    prisma.scheduleExtraTag.findMany({
      where: {
        date: { gte: start, lte: end },
      },
      select: {
        caddyId: true,
        tag: true,
        date: true,
      },
    }),
  ]);

  const availability = computeAvailability({
    date: ymd,
    caddies: caddies.map((c) => ({
      id: c.id,
      name: c.name,
      team: c.team,
      teamOrder: c.teamOrder,
      employmentStatus: c.employmentStatus,
      caddyType: c.caddyType,
      extraFlags: c.extraFlags ?? [],
      thirdBandSubgroup: c.thirdBandSubgroup ?? null,
    })),
    assignments,
    extraTags,
  });

  let offNames: string[] = [];
  if (options?.includeOffSheet !== false) {
    const sheets =
      options?.offSheets ??
      (await fetchPublishedOffSheets({ force: options?.forceOffSheet === true }));
    rememberOffSheetsForDate(ymd, sheets);
    offNames = requireOffNamesForDate(sheets, ymd);
  }

  let dutyEntries: DutyExcelEntry[] = [];
  let dutySource: "file" | "stored" | "none" = "none";
  if (options?.dutyWorkbook) {
    dutyEntries = parseDutyMarshalLeaderWorkbook(options.dutyWorkbook, ymd)
      .entries;
    dutySource = "file";
  } else if (options?.dutyEntries && options.dutyEntries.length > 0) {
    dutyEntries = options.dutyEntries;
    dutySource = "file";
  } else if (options?.includeStoredOpsDuty !== false) {
    dutyEntries = await loadStoredDutyEntries(ymd);
    if (dutyEntries.length > 0) dutySource = "stored";
  }

  const overlaid = applyDailyExternalExclusions({
    availability,
    caddies,
    offNames,
    dutyEntries,
  });

  const slotGrid = buildTeamSlotGrid({
    availability: overlaid,
    occupants: caddies.map((c) => ({
      id: c.id,
      name: c.name,
      team: c.team,
      teamOrder: c.teamOrder,
      employmentStatus: String(c.employmentStatus),
    })),
  });

  return { ...overlaid, slotGrid, dutySource, dutyEntryCount: dutyEntries.length };
}
