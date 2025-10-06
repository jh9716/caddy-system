// src/lib/caddyStatus.ts
import type { CaddyStatus } from "@prisma/client";

// 화면 표시용 한↔영 매핑
export const statusToKo: Record<CaddyStatus, string> = {
  DAEGI: "대기",
  WORKING: "근무중",
  OFF: "휴무",
  SICK: "병가",
  MARSHAL: "마샬",
  FIRST_SHIFT: "첫대기",
  HOLE54: "54홀",
};

export const koToStatus: Record<string, CaddyStatus> = {
  "대기": "DAEGI",
  "근무중": "WORKING",
  "휴무": "OFF",
  "병가": "SICK",
  "마샬": "MARSHAL",
  "첫대기": "FIRST_SHIFT",
  "54홀": "HOLE54",
};

// 안전 변환 (한글/영문 아무거나 받아도 ENUM으로 변환)
export function normalizeStatus(input?: string | null): CaddyStatus {
  if (!input) return "WORKING";

  const up = input.toUpperCase();

  // 영문 ENUM이 들어온 경우
  if (["DAEGI","WORKING","OFF","SICK","MARSHAL","FIRST_SHIFT","HOLE54"].includes(up)) {
    return up as CaddyStatus;
  }

  // 한글 라벨이 들어온 경우
  return koToStatus[input] ?? "WORKING";
}
