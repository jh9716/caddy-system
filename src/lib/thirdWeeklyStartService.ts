/**
 * 3부반 주간 시작조 — 자동 순환 + 해당 주(월~일)만 유효한 수동 override.
 * Production migrate deploy 없음.
 */

import { prisma } from "@/lib/prisma";
import { parseYmd } from "@/lib/availabilityEngine";
import type { ThirdBandTeam } from "@/lib/caddyManage";
import {
  automaticThirdStartTeam,
  effectiveThirdStartTeam,
  isThirdWeeklyTeam,
  mondayOfWeek,
} from "@/lib/thirdWeeklyRotation";
import type { TeamAffiliationSnapshot } from "@/lib/teamAffiliation";
import { loadTeamAffiliationSnapshot } from "@/lib/teamAffiliationService";

export type ThirdWeeklyStartPayload = {
  date: string;
  weekStart: string;
  autoStartTeam: ThirdBandTeam;
  startTeam: ThirdBandTeam;
  overridden: boolean;
};

export class ThirdWeeklyStartError extends Error {
  status = 400;
  code = "third_weekly_start_invalid";
  constructor(message: string, code?: string, status?: number) {
    super(message);
    this.name = "ThirdWeeklyStartError";
    if (code) this.code = code;
    if (status) this.status = status;
  }
}

function weekStartDate(mondayYmd: string): Date {
  return parseYmd(mondayYmd).start;
}

function isMissingTableError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e ?? "");
  const code =
    e && typeof e === "object" && "code" in e
      ? String((e as { code?: unknown }).code)
      : "";
  return (
    code === "P2021" ||
    /ThirdWeeklyStartOverride/i.test(msg) ||
    /does not exist/i.test(msg)
  );
}

async function loadOverrideRow(
  mondayYmd: string
): Promise<{ weekStart: string; startTeam: string } | null> {
  try {
    const row = await prisma.thirdWeeklyStartOverride.findUnique({
      where: { weekStart: weekStartDate(mondayYmd) },
      select: { startTeam: true },
    });
    if (!row) return null;
    return { weekStart: mondayYmd, startTeam: row.startTeam };
  } catch (e) {
    if (isMissingTableError(e)) return null;
    throw e;
  }
}

export async function resolveThirdWeeklyStart(
  ymd: string,
  snapshot?: TeamAffiliationSnapshot | null
): Promise<ThirdWeeklyStartPayload> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) {
    throw new ThirdWeeklyStartError("date=YYYY-MM-DD 필요");
  }
  const affiliation = snapshot ?? (await loadTeamAffiliationSnapshot(ymd));
  const weekStart = mondayOfWeek(ymd);
  const override = await loadOverrideRow(weekStart);
  const startTeam = effectiveThirdStartTeam(
    ymd,
    override,
    affiliation
  ) as ThirdBandTeam;
  return {
    date: ymd,
    weekStart,
    autoStartTeam: automaticThirdStartTeam(ymd),
    startTeam,
    overridden: Boolean(
      override && isThirdWeeklyTeam(override.startTeam, affiliation)
    ),
  };
}

export async function setThirdWeeklyStartOverride(
  ymd: string,
  startTeam: string
): Promise<ThirdWeeklyStartPayload> {
  const affiliation = await loadTeamAffiliationSnapshot(ymd);
  if (!isThirdWeeklyTeam(startTeam, affiliation)) {
    throw new ThirdWeeklyStartError(
      "이번 주 3부반 시작조는 운영 중인 THIRD 조만 선택할 수 있습니다."
    );
  }
  const weekStart = mondayOfWeek(ymd);
  try {
    await prisma.thirdWeeklyStartOverride.upsert({
      where: { weekStart: weekStartDate(weekStart) },
      create: { weekStart: weekStartDate(weekStart), startTeam },
      update: { startTeam },
    });
  } catch (e) {
    if (isMissingTableError(e)) {
      throw new ThirdWeeklyStartError(
        "주간 시작조 저장 테이블이 아직 없습니다. migration 적용 후 사용하세요.",
        "third_weekly_start_unavailable",
        503
      );
    }
    throw e;
  }
  return resolveThirdWeeklyStart(ymd);
}

export async function clearThirdWeeklyStartOverride(
  ymd: string
): Promise<ThirdWeeklyStartPayload> {
  const weekStart = mondayOfWeek(ymd);
  try {
    await prisma.thirdWeeklyStartOverride.deleteMany({
      where: { weekStart: weekStartDate(weekStart) },
    });
  } catch (e) {
    if (isMissingTableError(e)) {
      return resolveThirdWeeklyStart(ymd);
    }
    throw e;
  }
  return resolveThirdWeeklyStart(ymd);
}

/** 엔진 입력용: DB override 실패 시 자동값 */
export async function loadEffectiveThirdStartTeam(
  ymd: string,
  snapshot?: TeamAffiliationSnapshot | null
): Promise<ThirdBandTeam> {
  try {
    return (await resolveThirdWeeklyStart(ymd, snapshot)).startTeam;
  } catch {
    return automaticThirdStartTeam(ymd);
  }
}
