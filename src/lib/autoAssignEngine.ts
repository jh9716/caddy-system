/**
 * 기본 캐디 자동배치 엔진 v1 (자동배치 3단계)
 * - 순수 함수: DB write 없음
 * - 일반 available 순번 배치만 (special 미투입)
 */

import { PRIMARY_TEAMS } from "@/lib/caddyManage";
import { SHIFT_PARTS, type ShiftPart } from "@/lib/reservationParser";

export type AutoAssignCaddy = {
  id: number;
  name: string;
  team: string;
  teamOrder: number;
  caddyType?: string;
  extraFlags?: string[] | null;
};

export type AutoAssignReservation = {
  date: string;
  course: string;
  courseLabel?: string;
  shift: ShiftPart | string;
  teeTime: string;
  teamName: string | null;
  hole?: number | null;
  startingHole?: number | null;
  sourceSheet?: string;
  rawRowIndex?: number;
  needsReview?: boolean;
  isDuplicate?: boolean;
  reviewReasons?: string[];
};

export type AutoAssignmentRow = {
  date: string;
  shift: ShiftPart;
  sequenceIndex: number;
  reason: string;
  reservation: AutoAssignReservation;
  caddy: AutoAssignCaddy;
};

export type UnassignedReservationRow = {
  reservation: AutoAssignReservation;
  reason: string;
};

export type AutoAssignResultV1 = {
  date: string;
  assignments: AutoAssignmentRow[];
  unassignedReservations: UnassignedReservationRow[];
  unusedCaddies: AutoAssignCaddy[];
  /** v1에서 자동 배치하지 않음 — 그대로 전달 */
  special: AutoAssignCaddy[];
  meta: {
    availableCount: number;
    reservationCount: number;
    assignedCount: number;
    unassignedCount: number;
    unusedCount: number;
    specialCount: number;
    byShift: Record<
      ShiftPart,
      { reservations: number; assigned: number; unassigned: number }
    >;
    finalPointer: number;
  };
};

function teamRank(team: string): number {
  const idx = (PRIMARY_TEAMS as readonly string[]).indexOf(team);
  if (idx >= 0) return idx;
  return PRIMARY_TEAMS.length + 100;
}

export function compareCaddyOrder(a: AutoAssignCaddy, b: AutoAssignCaddy): number {
  const tr = teamRank(a.team) - teamRank(b.team);
  if (tr !== 0) return tr;
  if (a.team !== b.team) return a.team.localeCompare(b.team, "ko");
  if (a.teamOrder !== b.teamOrder) return a.teamOrder - b.teamOrder;
  return a.id - b.id;
}

function shiftRank(shift: string): number {
  const idx = (SHIFT_PARTS as readonly string[]).indexOf(shift);
  return idx >= 0 ? idx : 99;
}

export function compareReservationOrder(
  a: AutoAssignReservation,
  b: AutoAssignReservation
): number {
  const sr = shiftRank(String(a.shift)) - shiftRank(String(b.shift));
  if (sr !== 0) return sr;
  if (a.teeTime !== b.teeTime) return a.teeTime.localeCompare(b.teeTime);
  if (a.course !== b.course) return a.course.localeCompare(b.course);
  const ra = a.rawRowIndex ?? 0;
  const rb = b.rawRowIndex ?? 0;
  if (ra !== rb) return ra - rb;
  return String(a.teamName || "").localeCompare(String(b.teamName || ""), "ko");
}

function emptyShiftMeta(): Record<
  ShiftPart,
  { reservations: number; assigned: number; unassigned: number }
> {
  return {
    "1부": { reservations: 0, assigned: 0, unassigned: 0 },
    "2부": { reservations: 0, assigned: 0, unassigned: 0 },
    "3부": { reservations: 0, assigned: 0, unassigned: 0 },
  };
}

function dedupeCaddies(caddies: AutoAssignCaddy[]): AutoAssignCaddy[] {
  const seen = new Set<number>();
  const out: AutoAssignCaddy[] = [];
  for (const c of caddies) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
  }
  return out;
}

function isAssignableReservation(
  r: AutoAssignReservation,
  date: string
): { ok: true } | { ok: false; reason: string } {
  if (r.date && r.date !== date) {
    return { ok: false, reason: `날짜 불일치(${r.date})` };
  }
  if (r.needsReview) {
    return {
      ok: false,
      reason: `needsReview(${(r.reviewReasons || []).join(",") || "검토필요"})`,
    };
  }
  if (r.isDuplicate) {
    return { ok: false, reason: "중복 티타임" };
  }
  if (!SHIFT_PARTS.includes(r.shift as ShiftPart)) {
    return { ok: false, reason: `부 판별 실패(${r.shift || ""})` };
  }
  if (!r.teeTime || !/^\d{2}:\d{2}$/.test(r.teeTime)) {
    return { ok: false, reason: "티타임 없음/형식오류" };
  }
  return { ok: true };
}

/**
 * v1 자동배치:
 * - 예약: 1부→2부→3부, 같은 부 안 teeTime 오름차순
 * - 캐디: 조(1~12)+teamOrder 정렬된 available만 사용
 * - 순번 포인터는 shift가 바뀌어도 이어짐 (wrap-around)
 * - 같은 shift 안에서는 동일 캐디 중복 배치 금지
 * - special은 배치하지 않고 결과에 별도 포함
 */
export function computeAutoAssignmentsV1(input: {
  date: string;
  reservations: AutoAssignReservation[];
  available: AutoAssignCaddy[];
  special?: AutoAssignCaddy[];
}): AutoAssignResultV1 {
  const date = input.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error("date must be YYYY-MM-DD");
  }

  const special = dedupeCaddies([...(input.special || [])]).sort(compareCaddyOrder);
  const available = dedupeCaddies([...(input.available || [])]).sort(compareCaddyOrder);

  const assignments: AutoAssignmentRow[] = [];
  const unassignedReservations: UnassignedReservationRow[] = [];
  const byShift = emptyShiftMeta();
  const usedCaddyIds = new Set<number>();

  // 날짜 필터: date가 비어 있으면 input.date로 간주
  const dayReservations = (input.reservations || []).map((r) =>
    r.date ? r : { ...r, date }
  );

  const eligible: AutoAssignReservation[] = [];
  for (const r of dayReservations) {
    if (r.date && r.date !== date) continue; // other day — ignore silently
    const check = isAssignableReservation(r, date);
    if (!check.ok) {
      unassignedReservations.push({ reservation: r, reason: check.reason });
      continue;
    }
    eligible.push(r);
  }

  eligible.sort(compareReservationOrder);

  let pointer = 0;

  for (const shift of SHIFT_PARTS) {
    const shiftReservations = eligible.filter((r) => r.shift === shift);
    byShift[shift].reservations = shiftReservations.length;
    const usedInShift = new Set<number>();

    for (const reservation of shiftReservations) {
      if (available.length === 0) {
        unassignedReservations.push({
          reservation,
          reason: "가용 캐디 없음",
        });
        byShift[shift].unassigned += 1;
        continue;
      }

      // 같은 부에 아직 안 쓴 캐디를 포인터부터 원형으로 탐색
      let picked: AutoAssignCaddy | null = null;
      let pickedIndex = -1;
      for (let attempt = 0; attempt < available.length; attempt++) {
        const idx = (pointer + attempt) % available.length;
        const caddy = available[idx];
        if (usedInShift.has(caddy.id)) continue;
        picked = caddy;
        pickedIndex = idx;
        // 다음 예약은 이번 선택 다음 순번부터
        pointer = (idx + 1) % available.length;
        break;
      }

      if (!picked || pickedIndex < 0) {
        unassignedReservations.push({
          reservation,
          reason: `같은 부 중복 방지로 배치 불가(가용 ${available.length}명)`,
        });
        byShift[shift].unassigned += 1;
        continue;
      }

      usedInShift.add(picked.id);
      usedCaddyIds.add(picked.id);
      assignments.push({
        date,
        shift,
        sequenceIndex: pickedIndex,
        reason: `v1순번배치(${shift}, seq=${pickedIndex})`,
        reservation,
        caddy: picked,
      });
      byShift[shift].assigned += 1;
    }
  }

  const unusedCaddies = available.filter((c) => !usedCaddyIds.has(c.id));

  return {
    date,
    assignments,
    unassignedReservations,
    unusedCaddies,
    special,
    meta: {
      availableCount: available.length,
      reservationCount: eligible.length,
      assignedCount: assignments.length,
      unassignedCount: unassignedReservations.length,
      unusedCount: unusedCaddies.length,
      specialCount: special.length,
      byShift,
      finalPointer: available.length === 0 ? 0 : pointer,
    },
  };
}
