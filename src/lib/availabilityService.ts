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
  requireOffNamesForDate,
} from "@/lib/offSheetFetch";
import type { OffSheet } from "@/lib/offSheetParser";
import {
  parseDutyMarshalLeaderWorkbook,
  type DutyExcelEntry,
} from "@/lib/dutyMarshalLeaderParser";

export type AvailabilityWithSlotGrid = DailyAvailabilityResult & {
  slotGrid: TeamSlotGrid;
};

export type LoadAvailabilityOptions = {
  /** 테스트/미리 읽은 시트. 없으면 운영 Sheet를 fetch */
  offSheets?: OffSheet[];
  /** 당번·마샬·조장 파일 버퍼 (없으면 해당 제외 없음) */
  dutyWorkbook?: Buffer | ArrayBuffer | Uint8Array | null;
  /** false면 휴무 Sheet를 읽지 않음 (기본 true) */
  includeOffSheet?: boolean;
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
    const sheets = options?.offSheets ?? (await fetchPublishedOffSheets());
    offNames = requireOffNamesForDate(sheets, ymd);
  }

  let dutyEntries: DutyExcelEntry[] = [];
  if (options?.dutyWorkbook) {
    dutyEntries = parseDutyMarshalLeaderWorkbook(options.dutyWorkbook, ymd)
      .entries;
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

  return { ...overlaid, slotGrid };
}
