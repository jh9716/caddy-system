/**
 * Live apply freshness: reject a client `previous` that is older than DB live.
 * Placement fingerprint only. No draft version, no schema change.
 */
import { parseYmd } from "@/lib/availabilityEngine";
import {
  isPlacementLocked,
  reservationKey,
  resolveCourseCode,
  parseAssignShiftPart,
  type AutoAssignResultV1,
} from "@/lib/autoAssignEngine";

export const LIVE_STATE_CONFLICT = "LIVE_STATE_CONFLICT";
export const LIVE_STATE_CONFLICT_MESSAGE =
  "다른 직원이 이 날짜 배치표를 수정했습니다. 최신 내용을 다시 불러와 주세요.";

export type LivePlacementFingerRow = {
  key: string;
  teeTime: string;
  course: string;
  shift: string;
  caddyId: number;
  kind: string;
  locked: boolean;
};

type LivePlacementLoader = {
  dailyPlacement?: {
    findMany: (args: {
      where: { date: Date };
      select: {
        caddyId: true;
        kind: true;
        locked: true;
        reservation: {
          select: {
            identityKey: true;
            teeTime: true;
            course: true;
            shift: true;
            status: true;
          };
        };
      };
    }) => Promise<
      Array<{
        caddyId: number;
        kind: string;
        locked: boolean;
        reservation: {
          identityKey: string;
          teeTime: string;
          course: string;
          shift: string;
          status: string;
        };
      }>
    >;
  };
};

export function livePlacementFingerprintFromRows(
  rows: LivePlacementFingerRow[]
): string {
  return JSON.stringify(
    [...rows].sort((a, b) => a.key.localeCompare(b.key) || a.teeTime.localeCompare(b.teeTime))
  );
}

export function livePlacementFingerprintFromResult(
  result: AutoAssignResultV1
): string {
  return livePlacementFingerprintFromRows(
    result.assignments.map((row) => ({
      key: reservationKey(row.reservation),
      teeTime: String(row.reservation.teeTime),
      course: String(
        resolveCourseCode(String(row.reservation.course)) || row.reservation.course
      ),
      shift: String(
        parseAssignShiftPart(row.shift || row.reservation.shift) ||
          row.reservation.shift
      ),
      caddyId: row.caddy.id,
      kind: String(row.kind),
      locked: isPlacementLocked(row),
    }))
  );
}

/** No live rows → not stale (first persist / unpublished). */
export function isStaleLivePrevious(
  clientPrevious: AutoAssignResultV1,
  liveFingerprint: string | null
): boolean {
  if (liveFingerprint == null) return false;
  return livePlacementFingerprintFromResult(clientPrevious) !== liveFingerprint;
}

export function staleLivePreviousConflict(): {
  ok: false;
  httpStatus: 409;
  code: typeof LIVE_STATE_CONFLICT;
  message: string;
} {
  return {
    ok: false,
    httpStatus: 409,
    code: LIVE_STATE_CONFLICT,
    message: LIVE_STATE_CONFLICT_MESSAGE,
  };
}

export async function loadLivePlacementFingerprint(
  db: LivePlacementLoader | null | undefined,
  date: string
): Promise<string | null> {
  if (!db || typeof db.dailyPlacement?.findMany !== "function") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const rows = await db.dailyPlacement.findMany({
    where: { date: parseYmd(date).start },
    select: {
      caddyId: true,
      kind: true,
      locked: true,
      reservation: {
        select: {
          identityKey: true,
          teeTime: true,
          course: true,
          shift: true,
          status: true,
        },
      },
    },
  });
  const active = rows.filter(
    (row) => String(row.reservation.status || "").toUpperCase() === "ACTIVE"
  );
  if (active.length === 0) return null;
  return livePlacementFingerprintFromRows(
    active.map((row) => ({
      key: String(row.reservation.identityKey),
      teeTime: String(row.reservation.teeTime),
      course: String(
        resolveCourseCode(String(row.reservation.course)) || row.reservation.course
      ),
      shift: String(
        parseAssignShiftPart(row.reservation.shift) || row.reservation.shift
      ),
      caddyId: row.caddyId,
      kind: String(row.kind),
      locked: row.locked === true,
    }))
  );
}

export async function rejectStaleLivePrevious(
  previous: AutoAssignResultV1,
  opts?: {
    currentLive?: AutoAssignResultV1 | null;
    prisma?: LivePlacementLoader | null;
  }
): Promise<
  | { ok: true }
  | {
      ok: false;
      httpStatus: 409;
      code: typeof LIVE_STATE_CONFLICT;
      message: string;
    }
> {
  let fingerprint: string | null = null;
  if (opts && "currentLive" in (opts || {}) && opts?.currentLive !== undefined) {
    fingerprint =
      opts.currentLive && opts.currentLive.assignments.length > 0
        ? livePlacementFingerprintFromResult(opts.currentLive)
        : null;
  } else if (opts?.prisma) {
    fingerprint = await loadLivePlacementFingerprint(opts.prisma, previous.date);
  } else {
    return { ok: true };
  }
  if (isStaleLivePrevious(previous, fingerprint)) {
    return staleLivePreviousConflict();
  }
  return { ok: true };
}
