/**
 * 마샬 월표 화면용 순수 UI 계약.
 * 순환 엔진 / Daily Ops / Credit·벌당 계산은 바꾸지 않는다.
 */

import { listMonthYmds, shiftLabel, sourceLabel } from "@/lib/marshalRotationDomain";

export const MARSHAL_WEEKDAY_LABELS = ["일", "월", "화", "수", "목", "금", "토"] as const;

export type MarshalScheduleShift = "AM" | "PM";

export type MarshalScheduleSlotView = {
  id: number;
  date: string;
  shift: MarshalScheduleShift;
  slotIndex: number;
  caddyId: number;
  source: string;
  warning: string | null;
  note: string | null;
  caddy: { id: number; name: string; team?: string };
  originalCaddy?: { id: number; name: string } | null;
};

export type MarshalCalendarCell = {
  ymd: string | null;
  day: number | null;
  weekday: number;
  inMonth: boolean;
};

export type MarshalDayOccurrenceBadge = {
  caddyId: number;
  name: string;
  source: "AUTO" | "MANUAL";
};

export type MarshalDayBoard = {
  ymd: string;
  day: number;
  weekday: number;
  weekdayLabel: string;
  am: MarshalScheduleSlotView[];
  pm: MarshalScheduleSlotView[];
  amNames: string[];
  pmNames: string[];
  hasWarning: boolean;
  hasSubstitute: boolean;
  hasPenalty: boolean;
  penaltyCount: number;
  occurrenceBadges: MarshalDayOccurrenceBadge[];
};

export function weekdayIndexFromYmd(ymd: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || "").trim());
  if (!match) return 0;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return new Date(year, month - 1, day).getDay();
}

export function shiftYearMonth(
  year: number,
  month: number,
  delta: number
): { year: number; month: number } {
  const origin = Number(year) * 12 + (Number(month) - 1) + Number(delta);
  const nextYear = Math.floor(origin / 12);
  const nextMonth = (origin % 12) + 1;
  return { year: nextYear, month: nextMonth };
}

export function buildMonthCalendar(
  year: number,
  month: number
): MarshalCalendarCell[] {
  const ymds = listMonthYmds(year, month);
  const firstWeekday = weekdayIndexFromYmd(ymds[0] || `${year}-${String(month).padStart(2, "0")}-01`);
  const cells: MarshalCalendarCell[] = [];
  for (let weekday = 0; weekday < firstWeekday; weekday += 1) {
    cells.push({ ymd: null, day: null, weekday, inMonth: false });
  }
  for (const ymd of ymds) {
    cells.push({
      ymd,
      day: Number(ymd.slice(8)),
      weekday: weekdayIndexFromYmd(ymd),
      inMonth: true,
    });
  }
  while (cells.length % 7 !== 0) {
    cells.push({
      ymd: null,
      day: null,
      weekday: cells.length % 7,
      inMonth: false,
    });
  }
  return cells;
}

export function groupSlotsByDate(
  slots: readonly MarshalScheduleSlotView[]
): Map<string, MarshalScheduleSlotView[]> {
  const map = new Map<string, MarshalScheduleSlotView[]>();
  for (const slot of slots) {
    const list = map.get(slot.date) || [];
    list.push(slot);
    map.set(slot.date, list);
  }
  for (const list of map.values()) {
    list.sort((a, b) => {
      if (a.shift !== b.shift) return a.shift === "AM" ? -1 : 1;
      return a.slotIndex - b.slotIndex;
    });
  }
  return map;
}

export function slotsForShift(
  slots: readonly MarshalScheduleSlotView[],
  shift: MarshalScheduleShift
): MarshalScheduleSlotView[] {
  return slots
    .filter((slot) => slot.shift === shift)
    .slice()
    .sort((a, b) => a.slotIndex - b.slotIndex);
}

export function slotNames(slots: readonly MarshalScheduleSlotView[]): string[] {
  return slots.map((slot) => String(slot.caddy?.name ?? "").trim() || "이름없음");
}

export function joinMarshalNames(names: readonly string[]): string {
  return names.filter(Boolean).join("·") || "—";
}

export function summarizeMarshalNames(
  names: readonly string[],
  limit = 3
): { shown: string[]; extra: number; text: string } {
  const clean = names.filter(Boolean);
  const extra = Math.max(0, clean.length - limit);
  const shown = extra > 0 ? clean.slice(0, limit) : clean;
  const text =
    extra > 0
      ? `${joinMarshalNames(shown)} +${extra}`
      : joinMarshalNames(shown);
  return { shown, extra, text };
}

export function planStatusLabel(status: string | null | undefined): string {
  const raw = String(status ?? "").trim().toUpperCase();
  if (raw === "FINALIZED") return "마감 (FINALIZED)";
  if (raw === "DRAFT") return "초안 (DRAFT)";
  return "없음";
}

export function buildMarshalDayBoard(input: {
  ymd: string;
  slots?: readonly MarshalScheduleSlotView[];
  penalties?: readonly { date: string }[];
  occurrences?: readonly {
    scheduledOn?: string | null;
    status?: string;
    caddyId: number;
    scheduleSource?: string | null;
    caddy?: { name?: string | null } | null;
  }[];
}): MarshalDayBoard {
  const ymd = String(input.ymd);
  const weekday = weekdayIndexFromYmd(ymd);
  const daySlots = (input.slots || []).filter((slot) => slot.date === ymd);
  const am = slotsForShift(daySlots, "AM");
  const pm = slotsForShift(daySlots, "PM");
  const penaltyCount = (input.penalties || []).filter((row) => row.date === ymd).length;
  const occurrenceBadges = (input.occurrences || [])
    .filter(
      (row) =>
        String(row.status || "SCHEDULED").toUpperCase() === "SCHEDULED" &&
        row.scheduledOn === ymd
    )
    .map((row) => ({
      caddyId: row.caddyId,
      name: String(row.caddy?.name || "").trim() || "이름없음",
      source: String(row.scheduleSource || "").toUpperCase() === "MANUAL"
        ? ("MANUAL" as const)
        : ("AUTO" as const),
    }));
  return {
    ymd,
    day: Number(ymd.slice(8)) || 0,
    weekday,
    weekdayLabel: MARSHAL_WEEKDAY_LABELS[weekday] || "",
    am,
    pm,
    amNames: slotNames(am),
    pmNames: slotNames(pm),
    hasWarning: daySlots.some((slot) => Boolean(slot.warning)),
    hasSubstitute: daySlots.some(
      (slot) => slot.source === "SUBSTITUTE" || Boolean(slot.originalCaddy)
    ),
    hasPenalty:
      penaltyCount > 0 ||
      daySlots.some((slot) => slot.source === "PENALTY") ||
      occurrenceBadges.length > 0,
    penaltyCount,
    occurrenceBadges,
  };
}

export function formatCompactShifts(day: MarshalDayBoard): string {
  return `조출 ${joinMarshalNames(day.amNames)} | 후출 ${joinMarshalNames(day.pmNames)}`;
}

export function formatCompactDayLine(day: MarshalDayBoard): string {
  return `${day.day} ${day.weekdayLabel} | ${formatCompactShifts(day)}`;
}

export function listMonthDayBoards(input: {
  year: number;
  month: number;
  slots?: readonly MarshalScheduleSlotView[];
  penalties?: readonly { date: string }[];
  occurrences?: readonly {
    scheduledOn?: string | null;
    status?: string;
    caddyId: number;
    scheduleSource?: string | null;
    caddy?: { name?: string | null } | null;
  }[];
}): MarshalDayBoard[] {
  return listMonthYmds(input.year, input.month).map((ymd) =>
    buildMarshalDayBoard({
      ymd,
      slots: input.slots,
      penalties: input.penalties,
      occurrences: input.occurrences,
    })
  );
}

export function marshalSlotSourceText(source: string): string {
  return sourceLabel(source);
}

export function marshalShiftText(shift: string): string {
  return shiftLabel(shift);
}

export function marshalScheduleIntroText(): string {
  return [
    "순번은 월을 넘어 이어집니다. 일반 휴무는 건너뛰지 않고 경고만 표시합니다.",
    "마감(FINALIZED)된 월표는 Daily Ops가 당일 마샬 근무를 읽어 보여 줍니다.",
    "당번 데이터로 복사하거나 저장하지는 않습니다.",
  ].join(" ");
}

export function nextScheduleRequestId(current: number): number {
  return Number(current) + 1;
}

export function matchesRequestedYearMonth(
  payload: { year?: unknown; month?: unknown } | null | undefined,
  year: number,
  month: number
): boolean {
  return Number(payload?.year) === Number(year) && Number(payload?.month) === Number(month);
}

export function shouldApplyScheduleFetch(input: {
  requestId: number;
  latestRequestId: number;
  payload: { year?: unknown; month?: unknown } | null | undefined;
  year: number;
  month: number;
}): boolean {
  if (Number(input.requestId) !== Number(input.latestRequestId)) return false;
  return matchesRequestedYearMonth(input.payload, input.year, input.month);
}

export const MARSHAL_SCHEDULE_FETCH_STATES = [
  "LOADING",
  "SUCCESS_EMPTY",
  "SUCCESS_PLAN",
  "ERROR",
] as const;

export type MarshalScheduleFetchState =
  (typeof MARSHAL_SCHEDULE_FETCH_STATES)[number];

export type ScheduleFetchResultKind = "stale" | "success" | "error";

export type ScheduleFetchFailureKind = "http" | "network" | "mismatch";

export function resolveMarshalScheduleFetchState(input: {
  loading: boolean;
  fetchError: boolean;
  hasMatchingPayload: boolean;
  hasPlan: boolean;
}): MarshalScheduleFetchState {
  if (input.loading) return "LOADING";
  if (input.fetchError || !input.hasMatchingPayload) return "ERROR";
  return input.hasPlan ? "SUCCESS_PLAN" : "SUCCESS_EMPTY";
}

export function classifyScheduleFetchResult(input: {
  requestId: number;
  latestRequestId: number;
  ok: boolean;
  networkError?: boolean;
  payload: { year?: unknown; month?: unknown } | null | undefined;
  year: number;
  month: number;
}): ScheduleFetchResultKind {
  if (Number(input.requestId) !== Number(input.latestRequestId)) return "stale";
  if (input.networkError || !input.ok) return "error";
  if (!matchesRequestedYearMonth(input.payload, input.year, input.month)) {
    return "error";
  }
  return "success";
}

export function scheduleFetchFailureKind(input: {
  networkError?: boolean;
  ok?: boolean;
  payloadMatches: boolean;
}): ScheduleFetchFailureKind | null {
  if (input.networkError) return "network";
  if (input.ok === false) return "http";
  if (!input.payloadMatches) return "mismatch";
  return null;
}

export function scheduleFetchErrorMessage(
  kind: ScheduleFetchFailureKind | null | undefined
): string {
  if (kind === "network") return "월표를 불러오지 못했습니다. 네트워크 오류입니다.";
  if (kind === "mismatch") return "조회한 월이 선택한 월과 다릅니다.";
  return "월표 조회에 실패했습니다.";
}

export function nextFetchStateAfterLoad(input: {
  previous: MarshalScheduleFetchState;
  result: ScheduleFetchResultKind;
  hasPlan: boolean;
}): MarshalScheduleFetchState {
  if (input.result === "stale") return input.previous;
  if (input.result === "error") return "ERROR";
  return input.hasPlan ? "SUCCESS_PLAN" : "SUCCESS_EMPTY";
}

export function scheduleEmptyAllowed(state: MarshalScheduleFetchState): boolean {
  return state === "SUCCESS_EMPTY";
}

export function schedulePlanDisplayAllowed(
  state: MarshalScheduleFetchState
): boolean {
  return state === "SUCCESS_PLAN";
}

export function scheduleWorkspaceVisible(
  state: MarshalScheduleFetchState
): boolean {
  return state !== "ERROR";
}

export function scheduleMutationBlocked(input: {
  loading: boolean;
  busy: boolean;
  fetchState?: MarshalScheduleFetchState | null;
}): boolean {
  if (Boolean(input.loading) || Boolean(input.busy)) return true;
  return input.fetchState === "ERROR" || input.fetchState === "LOADING";
}

export function shouldScrollPcDayDetail(input: {
  selectedDate: string | null | undefined;
  calendarDisplay: string | null | undefined;
}): boolean {
  if (!input.selectedDate) return false;
  return String(input.calendarDisplay || "").trim() !== "none";
}
