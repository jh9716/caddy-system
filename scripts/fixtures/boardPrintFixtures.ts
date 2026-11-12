/**
 * 배치표 A4 인쇄 테스트 전용 합성 fixture. 앱 코드(src/)에서 import 하지 않는다.
 * 이름·팀명은 모두 합성값이다.
 */
import type { AssignmentDraft } from "../../src/lib/assignmentDraft";
import type { AssignmentKind, AutoAssignmentRow } from "../../src/lib/autoAssignEngine";
import { COURSE_CODES, type CourseCode, type ShiftPart } from "../../src/lib/reservationParser";

const SURNAMES = ["김", "이", "박", "최", "정", "강", "조", "윤", "장", "임", "한", "오", "서", "신", "권"];
const GIVEN = ["가람", "나래", "다은", "라희", "마루", "바다", "사랑", "아름", "자연", "차미", "하늘", "보람", "새봄", "슬기", "온유", "예린"];

export function synthName(i: number): string {
  return `${SURNAMES[i % SURNAMES.length]}${GIVEN[Math.floor(i / SURNAMES.length) % GIVEN.length]}`;
}

function hhmm(total: number): string {
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export function printRow(input: {
  date: string;
  shift: ShiftPart;
  course: CourseCode;
  teeTime: string;
  caddyId: number;
  caddyName: string;
  team?: string;
  kind?: AssignmentKind;
  teamName?: string | null;
  limousineCart?: boolean;
  houseRequest?: boolean;
  pairId?: string | null;
  reason?: string;
}): AutoAssignmentRow {
  return {
    date: input.date,
    shift: input.shift,
    sequenceIndex: 0,
    reason: input.reason ?? "TEST",
    kind: input.kind ?? "regular",
    pairId: input.pairId ?? null,
    reservation: {
      id: `${input.shift}-${input.course}-${input.teeTime}-${input.caddyId}`,
      date: input.date,
      course: input.course,
      shift: input.shift,
      teeTime: input.teeTime,
      teamName: input.teamName ?? null,
      rawRowIndex: 1,
      ...(input.limousineCart ? { limousineCart: true } : {}),
      ...(input.houseRequest ? { houseRequest: true } : {}),
    },
    caddy: {
      id: input.caddyId,
      name: input.caddyName,
      team: input.team ?? `${(input.caddyId % 9) + 1}조`,
      teamOrder: 1,
    },
  };
}

/** 부마다 다른 이름/팀명 접두사로 "부 섞임"을 검출할 수 있는 3부 draft */
export function threeShiftDraft(date = "2026-11-12"): AssignmentDraft {
  const rows: AutoAssignmentRow[] = [];
  const bands: Record<ShiftPart, [number, number]> = {
    "1부": [6 * 60 + 30, 8 * 60 + 40],
    "2부": [11 * 60 + 30, 13 * 60 + 40],
    "3부": [16 * 60, 17 * 60 + 10],
  };
  let id = 1;
  for (const shift of ["1부", "2부", "3부"] as ShiftPart[]) {
    const [start, end] = bands[shift];
    for (let t = start; t <= end; t += 7) {
      for (const course of COURSE_CODES) {
        const n = id++;
        rows.push(
          printRow({
            date,
            shift,
            course,
            teeTime: hhmm(t),
            caddyId: n,
            caddyName: synthName(n),
            teamName: `${shift}팀${course[0]}${hhmm(t).replace(":", "")}`,
            limousineCart: n % 11 === 0,
            houseRequest: n % 13 === 0,
          })
        );
      }
    }
  }
  return {
    date,
    status: "DRAFT",
    assignments: rows,
    unassignedReservations: [],
    closedCourseReservations: [],
    openCourses: [...COURSE_CODES],
    caddyPool: [],
    sparesByShift: [
      { shift: "1부", spare1: { caddyId: 900, name: "일스페어", team: "1조", teamOrder: 1 }, spare2: null },
      { shift: "2부", spare1: { caddyId: 901, name: "이스페어", team: "2조", teamOrder: 1 }, spare2: { caddyId: 902, name: "이보조", team: "3조", teamOrder: 1 } },
      { shift: "3부", spare1: null, spare2: null },
    ],
    confirmedAt: null,
  };
}

/** 스카이 휴장 + 오션 예약 없음 + 미배치 예약 + 빈 캐디 placeholder */
export function emptyAndUnassignedDraft(date = "2026-11-13"): AssignmentDraft {
  const shift: ShiftPart = "2부";
  const rows: AutoAssignmentRow[] = [];
  const times = ["11:30", "11:37", "11:44", "11:51", "11:58", "12:05"];
  times.forEach((tee, i) => {
    rows.push(printRow({ date, shift, course: "VERTHILL", teeTime: tee, caddyId: 100 + i, caddyName: synthName(100 + i) }));
    if (i % 2 === 0) {
      rows.push(printRow({ date, shift, course: "LAKE", teeTime: tee, caddyId: 200 + i, caddyName: synthName(200 + i) }));
    }
  });
  // 셀 편집으로 생긴 빈 캐디 칸 (id 0, 이름 없음)
  rows.push({
    ...printRow({ date, shift, course: "LAKE", teeTime: "11:37", caddyId: 0, caddyName: "" }),
    reason: "UNASSIGNED_VACANT",
  });
  return {
    date,
    status: "DRAFT",
    assignments: rows,
    unassignedReservations: [
      {
        reservation: { id: "u1", date, course: "LAKE", shift, teeTime: "11:51", teamName: "미배치합성팀", rawRowIndex: 1 },
        reason: "NO_CADDY",
      },
      {
        reservation: { id: "u2", date, course: "VERTHILL", shift, teeTime: "12:12", teamName: null, rawRowIndex: 2 },
        reason: "NO_CADDY",
      },
    ],
    closedCourseReservations: [],
    openCourses: ["VERTHILL", "OCEAN", "LAKE"],
    caddyPool: [],
    sparesByShift: [],
    confirmedAt: null,
  };
}

/** 여러 페이지로 넘어가는 큰 1부 (05:30~10:20, 2인 칸·긴 예약자명 포함) */
export function largeDraft(date = "2026-11-14"): AssignmentDraft {
  const shift: ShiftPart = "1부";
  const rows: AutoAssignmentRow[] = [];
  let id = 1000;
  const kinds: AssignmentKind[] = ["regular", "oneTwo", "twoThree", "fiftyFourHole"];
  for (let t = 5 * 60 + 30; t <= 10 * 60 + 20; t += 7) {
    for (const course of COURSE_CODES) {
      const n = id++;
      rows.push(
        printRow({
          date,
          shift,
          course,
          teeTime: hhmm(t),
          caddyId: n,
          caddyName: synthName(n),
          kind: kinds[n % 7 === 0 ? 1 + (n % 3) : 0],
          teamName: n % 5 === 0 ? `아주긴합성예약자명테스트팀${n}외3명` : `합성팀${n}`,
          limousineCart: n % 6 === 0,
          houseRequest: n % 9 === 0,
        })
      );
      if (n % 8 === 0) {
        const m = id++;
        rows.push(
          printRow({ date, shift, course, teeTime: hhmm(t), caddyId: m, caddyName: synthName(m), teamName: `합성팀${n}`, pairId: `p${n}` })
        );
      }
    }
  }
  return {
    date,
    status: "DRAFT",
    assignments: rows,
    unassignedReservations: [],
    closedCourseReservations: [],
    openCourses: [...COURSE_CODES],
    caddyPool: [],
    sparesByShift: [{ shift, spare1: { caddyId: 1, name: "합성스페어", team: "1조", teamOrder: 1 }, spare2: null }],
    confirmedAt: null,
  };
}

/** 코스별 시작·간격 (분). 실제 운영처럼 코스마다 다르게 둔다 (스카이 8분, 나머지 7분, 시작 엇갈림). */
export const FULL_LOAD_COURSE_PLAN: Record<ShiftPart, Record<CourseCode, { start: number; step: number }>> = {
  "1부": {
    VERTHILL: { start: 5 * 60 + 57, step: 7 },
    SKY: { start: 6 * 60 + 0, step: 8 },
    OCEAN: { start: 6 * 60 + 4, step: 7 },
    LAKE: { start: 6 * 60 + 11, step: 7 },
  },
  "2부": {
    VERTHILL: { start: 10 * 60 + 52, step: 7 },
    SKY: { start: 11 * 60 + 0, step: 8 },
    OCEAN: { start: 10 * 60 + 59, step: 7 },
    LAKE: { start: 11 * 60 + 6, step: 7 },
  },
  "3부": {
    VERTHILL: { start: 15 * 60 + 40, step: 7 },
    SKY: { start: 15 * 60 + 44, step: 8 },
    OCEAN: { start: 15 * 60 + 47, step: 7 },
    LAKE: { start: 15 * 60 + 54, step: 7 },
  },
};

export function fullLoadTeeTime(shift: ShiftPart, course: CourseCode, index: number): string {
  const p = FULL_LOAD_COURSE_PLAN[shift][course];
  return hhmm(p.start + p.step * index);
}

/**
 * 1·2·3부 × 4코스 × 21팀 만석 (부당 84팀, 총 252팀).
 * overflow: 특정 코스·부에 21팀 초과분을 추가 (잘림 검증용).
 * teeSheet 포함: 실제 티 행 = 예약 시각과 동일 (+ emptyTees 에 지정한 빈 티).
 */
export function fullLoadDraft(opts?: {
  date?: string;
  overflow?: { shift: ShiftPart; course: CourseCode; extra: number }[];
  emptyTees?: { shift: ShiftPart; course: CourseCode; index: number }[];
}): AssignmentDraft {
  const date = opts?.date ?? "2026-11-16";
  const rows: AutoAssignmentRow[] = [];
  const teeSheet: NonNullable<AssignmentDraft["teeSheet"]> = [];
  const empty = new Set((opts?.emptyTees || []).map((e) => `${e.shift}|${e.course}|${e.index}`));
  let id = 3000;
  for (const shift of ["1부", "2부", "3부"] as ShiftPart[]) {
    for (const course of COURSE_CODES) {
      const extra = (opts?.overflow || []).find((o) => o.shift === shift && o.course === course)?.extra ?? 0;
      for (let i = 0; i < 21 + extra; i++) {
        const teeTime = fullLoadTeeTime(shift, course, i);
        teeSheet.push({ course, shift, teeTime });
        if (empty.has(`${shift}|${course}|${i}`)) continue;
        const n = id++;
        rows.push(
          printRow({
            date,
            shift,
            course,
            teeTime,
            caddyId: n,
            caddyName: `${shift[0]}${course[0]}${synthName(n)}`,
            teamName: `${shift}예약${course[0]}${i + 1}`,
          })
        );
      }
    }
  }
  return {
    date,
    status: "DRAFT",
    assignments: rows,
    unassignedReservations: [],
    closedCourseReservations: [],
    openCourses: [...COURSE_CODES],
    caddyPool: [],
    teeSheet,
    sparesByShift: [],
    confirmedAt: null,
  };
}

/**
 * 모바일 4코스 보기 검증용: 21팀 만석 + 특수 표시(리무진·하우스·LOCK·드라이빙·지원·찾근·1·2/투) + 긴 이름 + 예약자명.
 * 같은 캐디가 1부·2부 1·2 연속근무 → 2부 칸에 '투'.
 */
export function richMobileDraft(date = "2026-11-17"): AssignmentDraft {
  const d = fullLoadDraft({ date });
  const byShiftCourse = (shift: ShiftPart, course: CourseCode) =>
    d.assignments.filter((a) => a.reservation.shift === shift && a.reservation.course === course);
  for (const shift of ["1부", "2부", "3부"] as ShiftPart[]) {
    for (const course of COURSE_CODES) {
      byShiftCourse(shift, course).forEach((a, i) => {
        const k = (i + COURSE_CODES.indexOf(course)) % 10;
        if (k === 1) a.reservation.limousineCart = true;
        if (k === 2) a.reservation.houseRequest = true;
        if (k === 3) a.locked = true;
        if (k === 4) a.kind = "driving";
        if (k === 5) {
          a.kind = "specialSupport";
          a.supportKind = "SPECIAL_SUPPORT";
          a.supportWorkPattern = "ONE_TWO";
        }
        if (k === 6) {
          a.kind = "fixed";
          a.reason = "찾근";
        }
      });
    }
  }
  // 긴 이름·긴 배지 조합 (칸 밖 넘침 검사)
  const long = byShiftCourse("1부", "SKY")[9];
  long.caddy = { ...long.caddy, name: "남궁가나다라마" };
  long.reservation.limousineCart = true;
  long.reservation.houseRequest = true;
  long.locked = true;
  // 1·2 연속근무: 1부 베르힐 8번째 캐디가 2부 베르힐 8번째에도
  const a1 = byShiftCourse("1부", "VERTHILL")[7];
  const a2 = byShiftCourse("2부", "VERTHILL")[7];
  a1.kind = "oneTwo";
  a2.kind = "oneTwo";
  a1.pairId = a2.pairId = "p-mobile-12";
  a2.caddy = { ...a1.caddy };
  // 2부 레이크: 빈 캐디 칸(미배치) 1개
  const v = byShiftCourse("2부", "LAKE")[3];
  v.caddy = { ...v.caddy, id: 0, name: "" };
  v.reason = "UNASSIGNED_VACANT";
  return d;
}
