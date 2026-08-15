/**
 * 가용 엔진용 DB 로더 (읽기 전용 SELECT)
 * Production 데이터 수정 없음.
 */
import { prisma } from "@/lib/prisma";
import {
  computeAvailability,
  parseYmd,
  type AvailabilityResult,
} from "@/lib/availabilityEngine";
import {
  buildTeamSlotGrid,
  type TeamSlotGrid,
} from "@/lib/availabilitySlotGrid";

export type AvailabilityWithSlotGrid = AvailabilityResult & {
  slotGrid: TeamSlotGrid;
};

export async function loadAvailabilityForDate(
  ymd: string
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
    })),
    assignments,
    extraTags,
  });

  const slotGrid = buildTeamSlotGrid({
    availability,
    occupants: caddies.map((c) => ({
      id: c.id,
      name: c.name,
      team: c.team,
      teamOrder: c.teamOrder,
      employmentStatus: String(c.employmentStatus),
    })),
  });

  return { ...availability, slotGrid };
}
