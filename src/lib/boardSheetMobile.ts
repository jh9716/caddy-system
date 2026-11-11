/**
 * /board 모바일 전용 4코스 동시 보기 모델 (표시 전용, 읽기 전용).
 *
 * 행·시각·칸 상태(배정/미배치/빈 티/휴장)·21행 기준·초과 확장은 공통 시트 모델(buildBoardSheetModel)
 * 그대로 쓴다. 칸 안의 표시(배지·LOCK·예약자명)는 기존 운영 모바일(PublishedBoardView)과 같게
 * Published placement 의 플래그에서 직접 읽는다 → 기존 화면보다 정보가 줄지 않는다.
 * 자동배치/순번/DB/API 와 무관.
 */
import type { BoardSheetModel, BoardSheetSlotState } from "@/lib/boardSheet";
import { BOARD_SHEET_BASE_ROWS } from "@/lib/boardSheet";
import { resolveCourseCode } from "@/lib/autoAssignEngine";
import type {
  DailyBoardPublishedPayloadV1,
  PublishedPlacementV1,
} from "@/lib/dailyBoardPublished";
import { supportBoardBadgeLabels } from "@/lib/dailySpecialSupport";
import type { CourseCode } from "@/lib/reservationParser";

export type BoardMobileBadgeTone =
  | "limo"
  | "house"
  | "drive"
  | "two"
  | "call"
  | "support"
  | "support-pat"
  | "linked"
  | "lock";

export type BoardMobileBadge = { label: string; tone: BoardMobileBadgeTone };

export type BoardMobileCaddy = {
  name: string;
  affiliation: string;
  badges: BoardMobileBadge[];
  vacant: boolean;
  locked: boolean;
  /** 기존 화면 칸 강조 (특수/투/찾근/리무진/드라이빙) */
  accent: Array<"special" | "two-work" | "chageun" | "limo" | "drive">;
};

export type BoardMobileSlot = {
  teeTime: string;
  state: BoardSheetSlotState;
  caddies: BoardMobileCaddy[];
  /** 서버가 보낸 범위(관리자·조장)일 때만 채워짐 */
  teamNames: string[];
};

export type BoardMobileCourse = {
  code: CourseCode;
  label: string;
  open: boolean;
  slots: BoardMobileSlot[];
};

export type BoardMobileModel = {
  sheet: BoardSheetModel;
  courses: BoardMobileCourse[];
  rowCount: number;
};

const LINKED_TAG: Partial<Record<string, string>> = {
  oneTwo: "1·2",
  two: "2",
  twoThree: "2·3",
  oneThree: "1·3",
  fiftyFourHole: "54",
};

function isVacantPlacement(p: PublishedPlacementV1): boolean {
  return !Number.isInteger(p.caddyId) || (p.caddyId as number) <= 0 || !String(p.caddyName || "").trim();
}

/** 기존 PublishedBoardView 배지 의미 그대로 + 연속근무 종류(1·2 등)는 공통 시트 표기 */
export function boardMobileBadges(p: PublishedPlacementV1, showLock = true): BoardMobileBadge[] {
  const out: BoardMobileBadge[] = [];
  if (p.limousine) out.push({ label: "리무진", tone: "limo" });
  if (p.houseRequest) out.push({ label: "하우스", tone: "house" });
  if (p.driving) out.push({ label: "드라이빙", tone: "drive" });
  if (p.twoWork) out.push({ label: "투", tone: "two" });
  if (p.chageun) out.push({ label: "찾근", tone: "call" });
  if (p.specialSupport) {
    const b = supportBoardBadgeLabels(p.supportKind, p.supportWorkPattern);
    if (b.kind) out.push({ label: b.kind, tone: "support" });
    if (b.pattern) out.push({ label: b.pattern, tone: "support-pat" });
  } else if (!p.chageun && !p.driving) {
    const tag = LINKED_TAG[p.kind];
    if (tag) out.push({ label: tag, tone: "linked" });
  }
  if (showLock && p.locked) out.push({ label: "LOCK", tone: "lock" });
  return out;
}

function caddyFromPlacement(p: PublishedPlacementV1): BoardMobileCaddy {
  if (isVacantPlacement(p)) {
    return { name: "", affiliation: "", badges: [], vacant: true, locked: false, accent: [] };
  }
  const accent: BoardMobileCaddy["accent"] = [];
  if (p.kind !== "regular") accent.push("special");
  if (p.twoWork) accent.push("two-work");
  if (p.chageun) accent.push("chageun");
  if (p.limousine) accent.push("limo");
  if (p.driving) accent.push("drive");
  return {
    name: String(p.caddyName || "").trim(),
    affiliation: String(p.caddyTeam || "").trim(),
    badges: boardMobileBadges(p),
    vacant: false,
    locked: p.locked === true,
    accent,
  };
}

/**
 * sheet = buildBoardSheetModel(assignmentDraftForPublishedView(payload), shift, {includeTeamName:true, showLock:true})
 * 와 같은 payload. 시각·칸 상태는 sheet 그대로, 칸 내용만 placement 로 채운다.
 */
export function buildBoardMobileModel(
  sheet: BoardSheetModel,
  payload: DailyBoardPublishedPayloadV1
): BoardMobileModel {
  const byKey = new Map<string, PublishedPlacementV1[]>();
  for (const p of payload.placements) {
    if (p.shift !== sheet.shift) continue;
    const code = resolveCourseCode(p.course);
    if (!code) continue;
    const key = `${code}|${p.teeTime}`;
    const list = byKey.get(key) || [];
    list.push(p);
    byKey.set(key, list);
  }
  const courses: BoardMobileCourse[] = sheet.courses.map((c) => ({
    code: c.code,
    label: c.label,
    open: c.open,
    slots: c.slots.map((s) => {
      const placements = s.state === "empty" ? [] : byKey.get(`${c.code}|${s.teeTime}`) || [];
      const fromPayload = placements.length > 0 && s.caddies.length > 0;
      const caddies: BoardMobileCaddy[] = fromPayload
        ? placements.map(caddyFromPlacement)
        : s.caddies.map((x) => ({
            name: x.name,
            affiliation: x.affiliation,
            badges: x.marks.map((m) => ({ label: m, tone: m === "LOCK" ? "lock" : "linked" }) as BoardMobileBadge),
            vacant: x.vacant,
            locked: x.marks.includes("LOCK"),
            accent: [],
          }));
      return { teeTime: s.teeTime, state: s.state, caddies, teamNames: s.teamNames };
    }),
  }));
  return { sheet, courses, rowCount: Math.max(BOARD_SHEET_BASE_ROWS, sheet.rowCount) };
}
