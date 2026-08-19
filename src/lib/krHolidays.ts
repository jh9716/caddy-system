/**
 * 대한민국 공휴일 판정 (로컬, 외부 API 없음).
 * 자동배치가 네트워크 장애로 실패하지 않도록 고정 규칙 + 음력 룩업만 사용.
 */

export type Ymd = `${number}-${number}-${number}` | string;

function parts(ymd: string): { y: number; m: number; d: number } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) {
    throw new Error("date must be YYYY-MM-DD");
  }
  const y = Number(ymd.slice(0, 4));
  const m = Number(ymd.slice(5, 7));
  const d = Number(ymd.slice(8, 10));
  return { y, m, d };
}

export function formatYmd(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** 0=일 … 6=토 (UTC 캘린더, TZ 영향 없음) */
export function weekdaySun0(ymd: string): number {
  const { y, m, d } = parts(ymd);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function addDays(ymd: string, delta: number): string {
  const { y, m, d } = parts(ymd);
  const dt = new Date(Date.UTC(y, m - 1, d + delta));
  return formatYmd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

/** 설날(음력 1/1) 양력 — 2020~2036 */
const SEOLLAL: Readonly<Record<number, string>> = {
  2020: "2020-01-25",
  2021: "2021-02-12",
  2022: "2022-02-01",
  2023: "2023-01-22",
  2024: "2024-02-10",
  2025: "2025-01-29",
  2026: "2026-02-17",
  2027: "2027-02-06",
  2028: "2028-01-26",
  2029: "2029-02-13",
  2030: "2030-02-03",
  2031: "2031-01-23",
  2032: "2032-02-11",
  2033: "2033-01-31",
  2034: "2034-02-19",
  2035: "2035-02-08",
  2036: "2036-01-28",
};

/** 추석(음력 8/15) 양력 — 2020~2036 */
const CHUSEOK: Readonly<Record<number, string>> = {
  2020: "2020-10-01",
  2021: "2021-09-21",
  2022: "2022-09-10",
  2023: "2023-09-29",
  2024: "2024-09-17",
  2025: "2025-10-06",
  2026: "2026-09-25",
  2027: "2027-09-15",
  2028: "2028-10-03",
  2029: "2029-09-22",
  2030: "2030-09-12",
  2031: "2031-10-01",
  2032: "2032-09-19",
  2033: "2033-09-08",
  2034: "2034-09-28",
  2035: "2035-09-16",
  2036: "2036-10-04",
};

/** 부처님오신날(음력 4/8) 양력 — 2020~2036 */
const BUDDHA: Readonly<Record<number, string>> = {
  2020: "2020-04-30",
  2021: "2021-05-19",
  2022: "2022-05-08",
  2023: "2023-05-27",
  2024: "2024-05-15",
  2025: "2025-05-05",
  2026: "2026-05-24",
  2027: "2027-05-13",
  2028: "2028-05-02",
  2029: "2029-05-20",
  2030: "2030-05-09",
  2031: "2031-05-28",
  2032: "2032-05-16",
  2033: "2033-05-06",
  2034: "2034-05-25",
  2035: "2035-05-15",
  2036: "2036-05-03",
};

const SOLAR: ReadonlyArray<readonly [number, number]> = [
  [1, 1],
  [3, 1],
  [5, 5],
  [6, 6],
  [8, 15],
  [10, 3],
  [10, 9],
  [12, 25],
];

function nextWeekday(ymd: string): string {
  let cur = addDays(ymd, 1);
  while (weekdaySun0(cur) === 0 || weekdaySun0(cur) === 6) {
    cur = addDays(cur, 1);
  }
  return cur;
}

function yearHolidays(year: number): Set<string> {
  const set = new Set<string>();
  for (const [m, d] of SOLAR) set.add(formatYmd(year, m, d));

  const seollal = SEOLLAL[year];
  if (seollal) {
    set.add(addDays(seollal, -1));
    set.add(seollal);
    set.add(addDays(seollal, 1));
  }
  const chuseok = CHUSEOK[year];
  if (chuseok) {
    set.add(addDays(chuseok, -1));
    set.add(chuseok);
    set.add(addDays(chuseok, 1));
  }
  const buddha = BUDDHA[year];
  if (buddha) set.add(buddha);

  const addSubstituteAfter = (after: string) => {
    let cand = nextWeekday(after);
    while (set.has(cand)) cand = nextWeekday(cand);
    set.add(cand);
  };

  // 설·추석 연휴: 토/일 또는 다른 공휴일과 겹치면 연휴 다음 평일을 대체
  for (const core of [seollal, chuseok]) {
    if (!core) continue;
    const period = [addDays(core, -1), core, addDays(core, 1)];
    const overlapsWeekend = period.some((d) => {
      const wd = weekdaySun0(d);
      return wd === 0 || wd === 6;
    });
    const others = [...set].filter((x) => !period.includes(x));
    const overlapsOther = period.some((d) => others.includes(d));
    if (overlapsWeekend || overlapsOther) {
      addSubstituteAfter(period[2]);
    }
  }

  // 3·1절, 어린이날, 광복절, 개천절, 한글날: 토/일이면 대체
  for (const [m, d] of [
    [3, 1],
    [5, 5],
    [8, 15],
    [10, 3],
    [10, 9],
  ] as const) {
    const day = formatYmd(year, m, d);
    const wd = weekdaySun0(day);
    if (wd === 0 || wd === 6) addSubstituteAfter(day);
  }

  return set;
}

const cache = new Map<number, Set<string>>();

export function krPublicHolidaysInYear(year: number): Set<string> {
  let set = cache.get(year);
  if (!set) {
    set = yearHolidays(year);
    cache.set(year, set);
  }
  return set;
}

export function isKrPublicHoliday(ymd: string): boolean {
  const { y } = parts(ymd);
  return krPublicHolidaysInYear(y).has(ymd);
}

/** 토/일 또는 대한민국 공휴일 — 주말반 3부 우선 적용일 */
export function isWeekendBandPriorityDate(ymd: string): boolean {
  const wd = weekdaySun0(ymd);
  if (wd === 0 || wd === 6) return true;
  try {
    return isKrPublicHoliday(ymd);
  } catch {
    return wd === 0 || wd === 6;
  }
}
