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


/** 2026-11-01 1부 형태의 짧은 아침 배치표 (06:00~06:49). DB 없이 현장 1부 초반을 흉내 냄.
 *  코스별 시각이 어긋나 한 행에 빈 칸과 배정 칸이 섞이고, 짧은 이름·긴 이름·배지가 함께 있다. */
export function shortMorningNov1Draft(): AssignmentDraft {
  const date = "2026-11-01";
  const plan: Record<CourseCode, string[]> = {
    VERTHILL: ["06:00", "06:07", "06:14", "06:21", "06:28", "06:35", "06:42", "06:49"],
    SKY: ["06:04", "06:12", "06:20", "06:28", "06:36", "06:44"],
    OCEAN: ["06:02", "06:09", "06:16", "06:23", "06:30", "06:37", "06:44"],
    LAKE: ["06:06", "06:13", "06:20", "06:27", "06:34", "06:41", "06:48"],
  };
  // [course, tee, name, team, teamName, flags]
  type Flag = "limo" | "house" | "lock" | "drive" | "call" | "none";
  const named: Array<{
    course: CourseCode; tee: string; name: string; team: string; teamName: string | null; flags: Flag[];
  }> = [
    { course: "VERTHILL", tee: "06:00", name: "김민수", team: "1조", teamName: "김예약", flags: [] },
    { course: "VERTHILL", tee: "06:07", name: "이서연", team: "2조", teamName: "아침A", flags: ["limo"] },
    { course: "VERTHILL", tee: "06:14", name: "박준", team: "3조", teamName: "박팀", flags: [] },
    { course: "VERTHILL", tee: "06:21", name: "테스트마셜19", team: "4조", teamName: "마셜예약", flags: ["house", "limo"] },
    { course: "VERTHILL", tee: "06:28", name: "최유진", team: "5조", teamName: "최예약", flags: ["lock"] },
    { course: "VERTHILL", tee: "06:35", name: "정하늘", team: "6조", teamName: "정팀", flags: [] },
    { course: "VERTHILL", tee: "06:42", name: "한소희", team: "7조", teamName: "한예약", flags: ["drive"] },
    { course: "VERTHILL", tee: "06:49", name: "오민재", team: "8조", teamName: "오팀", flags: [] },
    { course: "SKY", tee: "06:04", name: "강보미", team: "1조", teamName: "강예약", flags: [] },
    { course: "SKY", tee: "06:12", name: "윤지호", team: "2조", teamName: "윤팀", flags: ["house"] },
    { course: "SKY", tee: "06:20", name: "테스트캐디01", team: "3조", teamName: "테스트예약01", flags: ["limo", "lock"] },
    { course: "SKY", tee: "06:28", name: "신아린", team: "4조", teamName: "신예약", flags: [] },
    { course: "SKY", tee: "06:36", name: "문재성", team: "5조", teamName: "문팀", flags: ["call"] },
    { course: "SKY", tee: "06:44", name: "배서윤", team: "6조", teamName: "배예약", flags: [] },
    { course: "OCEAN", tee: "06:02", name: "조민", team: "1조", teamName: "조예약", flags: ["limo"] },
    { course: "OCEAN", tee: "06:09", name: "임하늘", team: "2조", teamName: "임팀", flags: [] },
    { course: "OCEAN", tee: "06:16", name: "남궁서연", team: "3조", teamName: "남궁예약", flags: ["house"] },
    { course: "OCEAN", tee: "06:23", name: "황민", team: "4조", teamName: "황예약", flags: [] },
    { course: "OCEAN", tee: "06:30", name: "서지훈", team: "5조", teamName: "서팀", flags: ["drive"] },
    { course: "OCEAN", tee: "06:37", name: "노은지", team: "6조", teamName: "노예약", flags: [] },
    { course: "OCEAN", tee: "06:44", name: "홍길동", team: "7조", teamName: "홍팀", flags: ["lock"] },
    { course: "LAKE", tee: "06:06", name: "유나", team: "1조", teamName: "유예약", flags: [] },
    { course: "LAKE", tee: "06:13", name: "장도윤", team: "2조", teamName: "장팀", flags: ["limo", "house"] },
    { course: "LAKE", tee: "06:20", name: "석민호", team: "3조", teamName: "석예약", flags: [] },
    { course: "LAKE", tee: "06:27", name: "고은", team: "4조", teamName: "고팀", flags: [] },
    { course: "LAKE", tee: "06:34", name: "변서준", team: "5조", teamName: "변예약", flags: ["call"] },
    { course: "LAKE", tee: "06:41", name: "차우리", team: "6조", teamName: "차팀", flags: [] },
    { course: "LAKE", tee: "06:48", name: "표지안", team: "7조", teamName: "표예약", flags: ["drive"] },
  ];
  const rows: AutoAssignmentRow[] = [];
  let id = 1101;
  for (const n of named) {
    const row = printRow({
      date,
      shift: "1부",
      course: n.course,
      teeTime: n.tee,
      caddyId: id++,
      caddyName: n.name,
      team: n.team,
      teamName: n.teamName,
      limousineCart: n.flags.includes("limo"),
      houseRequest: n.flags.includes("house"),
    });
    if (n.flags.includes("lock")) row.locked = true;
    if (n.flags.includes("drive")) row.kind = "driving";
    if (n.flags.includes("call")) {
      row.kind = "fixed";
      row.reason = "찾근";
    }
    rows.push(row);
  }
  const teeSheet: NonNullable<AssignmentDraft["teeSheet"]> = [];
  for (const course of COURSE_CODES) {
    for (const teeTime of plan[course]) teeSheet.push({ course, shift: "1부", teeTime });
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
    sparesByShift: [
      { shift: "1부", spare1: { caddyId: 9901, name: "김스페어", team: "1조", teamOrder: 1 }, spare2: null },
    ],
    confirmedAt: "2026-11-01T04:00:00+09:00",
  };
}

/** 2부·3부에 투근무 배지가 많이 나오도록, 같은 캐디가 앞 부에도 근무한 배치. */
export function manyTwoWorkDraft(date = "2026-11-18"): AssignmentDraft {
  const d = fullLoadDraft({ date });
  const by = (shift: ShiftPart, course: CourseCode) =>
    d.assignments.filter((a) => a.reservation.shift === shift && a.reservation.course === course);
  // 2부: 각 코스 21명 중 앞 16명이 1부 동일 코스 캐디 → 2부에 투 다수
  // 3부: 각 코스 21명 중 앞 16명이 1부 동일 코스 캐디 → 3부에 투 다수 (2부는 다른 캐디가 아닌 1부 재사용)
  // 1부 캐디를 2부와 3부 양쪽에 쓰면 1·2·3 전부. 그래도 twoWork는 뒷부에 표시됨.
  for (const course of COURSE_CODES) {
    const s1 = by("1부", course);
    const s2 = by("2부", course);
    const s3 = by("3부", course);
    const n = Math.min(16, s1.length, s2.length, s3.length);
    for (let i = 0; i < n; i++) {
      s2[i].caddy = { ...s1[i].caddy };
      s2[i].kind = "oneTwo";
      s2[i].pairId = `tw-${course}-12-${i}`;
      s1[i].kind = "oneTwo";
      s1[i].pairId = s2[i].pairId;
      // 3부: 1부 캐디를 다시 쓰되 1·3 패턴. 2부와 겹치면 54홀이 되지만 표시 검증 목적.
      s3[i].caddy = { ...s1[i].caddy };
      s3[i].kind = "oneThree";
      s3[i].pairId = `tw-${course}-13-${i}`;
    }
    // 긴 이름 + 여러 배지 (2부·3부 투와 함께)
    if (s2[2]) {
      s2[2].caddy = { ...s2[2].caddy, name: "테스트캐디01" };
      s2[2].reservation.limousineCart = true;
      s2[2].reservation.houseRequest = true;
      s2[2].locked = true;
    }
    if (s3[3]) {
      s3[3].caddy = { ...s3[3].caddy, name: "테스트마셜19" };
      s3[3].reservation.limousineCart = true;
      s3[3].locked = true;
      s3[3].kind = "driving";
    }
  }
  return d;
}

/**
 * 2026-11-01 1부 06:07 레이크 하우스 누락 재현용 픽스처 (DB 없음).
 * 해당 칸은 하우스만 있고 다른 배지는 없다 (모바일에서 Marks 숨김 회귀를 잡기 위함).
 * 같은 시각 베르힐은 리무진만(주황 하단 띠 재현). 2부·3부와 다른 날짜에도 하우스 칸을 둔다.
 */
export function nov1Lake0607HouseDraft(date = "2026-11-01"): AssignmentDraft {
  const rows: AutoAssignmentRow[] = [];
  const teeSheet: NonNullable<AssignmentDraft["teeSheet"]> = [];
  const add = (
    shift: ShiftPart,
    course: CourseCode,
    tee: string,
    name: string,
    team: string,
    teamName: string,
    opts?: { house?: boolean; limo?: boolean; two?: boolean; lock?: boolean; drive?: boolean; call?: boolean }
  ) => {
    const row = printRow({
      date,
      shift,
      course,
      teeTime: tee,
      caddyId: 5000 + rows.length,
      caddyName: name,
      team,
      teamName,
      houseRequest: opts?.house === true,
      limousineCart: opts?.limo === true,
    });
    if (opts?.lock) row.locked = true;
    if (opts?.drive) row.kind = "driving";
    if (opts?.call) {
      row.kind = "fixed";
      row.reason = "찾근";
    }
    if (opts?.two) {
      row.kind = "oneTwo";
      row.pairId = `tw-${shift}-${course}-${tee}`;
    }
    rows.push(row);
    teeSheet.push({ course, shift, teeTime: tee });
  };

  // 1부 06:07: 레이크 = 하우스만 (보고된 케이스). 베르힐 = 리무진만 (주황 띠).
  add("1부", "VERTHILL", "06:07", "이서연", "2조", "아침A", { limo: true });
  add("1부", "SKY", "06:07", "강보미", "1조", "강예약");
  add("1부", "OCEAN", "06:07", "조민", "1조", "조예약");
  add("1부", "LAKE", "06:07", "김하우", "3조", "레이크하우팀", { house: true });
  // 같은 부 다른 시각: 하우스+리무진, 하우스만
  add("1부", "LAKE", "06:14", "박준", "4조", "박팀", { house: true, limo: true });
  add("1부", "SKY", "06:14", "윤지호", "2조", "윤팀", { house: true });
  // 2부·3부 하우스 (회귀)
  add("2부", "LAKE", "11:07", "최유진", "5조", "오후하우팀", { house: true });
  add("2부", "VERTHILL", "11:07", "정하늘", "6조", "정팀", { house: true, limo: true });
  add("2부", "SKY", "11:07", "한소희", "7조", "한예약", { two: true });
  add("3부", "LAKE", "16:07", "오민재", "8조", "저녁하우팀", { house: true });
  add("3부", "OCEAN", "16:07", "임하늘", "2조", "임팀", { house: true, call: true });
  add("3부", "VERTHILL", "16:07", "남궁서연", "3조", "남궁예약", { house: true, lock: true });

  return {
    date,
    status: "DRAFT",
    assignments: rows,
    unassignedReservations: [],
    closedCourseReservations: [],
    openCourses: [...COURSE_CODES],
    caddyPool: [],
    teeSheet,
    sparesByShift: [
      { shift: "1부", spare1: { caddyId: 9911, name: "김스페어", team: "1조", teamOrder: 1 }, spare2: null },
    ],
    confirmedAt: null,
  };
}
