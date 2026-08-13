/**
 * 직원용 Caddy 연결 요청 UI 헬퍼 (표시/메시지만 — API/domain 미포함)
 */

export type StaffLinkRequestView = {
  id: number;
  status: string;
  submittedName: string;
  maskedPhone: string | null;
  requestedAt?: string | Date;
  decidedAt?: string | Date | null;
  decisionNote?: string | null;
};

export type MineLinkPayload = {
  linked: boolean;
  caddyId: number | null;
  request: StaffLinkRequestView | null;
};

/** 직원 /caddy/link 화면 모드 */
export type StaffLinkUiMode =
  | "redirect_caddy"
  | "pending"
  | "rejected"
  | "form";

export function resolveStaffLinkUiMode(
  mine: Pick<MineLinkPayload, "linked" | "request">
): StaffLinkUiMode {
  if (mine.linked) return "redirect_caddy";
  const status = mine.request?.status ?? null;
  if (status === "APPROVED") return "redirect_caddy";
  if (status === "PENDING") return "pending";
  if (status === "REJECTED") return "rejected";
  // null | CANCELLED | 기타 → 재신청/최초 신청 폼
  return "form";
}

/** API error code → 직원용 한국어 안내 */
export function staffLinkErrorMessage(
  code: string | null | undefined,
  fallback?: string | null
): string {
  const c = String(code || "").trim();
  switch (c) {
    case "no_candidates":
      return "등록된 캐디 이름과 일치하지 않습니다. 이름을 다시 확인하거나 관리자에게 문의해 주세요.";
    case "invalid_phone":
      return "휴대폰번호 형식이 올바르지 않습니다. 010으로 시작하는 번호를 입력해 주세요.";
    case "invalid_name":
      return "이름을 올바르게 입력해 주세요.";
    case "pending_exists":
      return "이미 승인 대기 중인 요청이 있습니다. 취소 후 다시 신청해 주세요.";
    case "already_linked":
      return "이미 캐디에 연결된 계정입니다.";
    case "not_linkable_user":
      return "카카오로 로그인한 캐디 계정만 본인확인 요청을 할 수 있습니다.";
    case "not_pending":
      return "대기 중인 요청만 취소할 수 있습니다. 화면을 새로고침해 주세요.";
    case "forbidden":
      return "본인 요청만 취소할 수 있습니다.";
    case "not_found":
      return "요청을 찾을 수 없습니다. 화면을 새로고침해 주세요.";
    case "unauthorized":
      return "로그인이 필요합니다.";
    case "invalid_request_id":
      return "유효하지 않은 요청입니다.";
    default:
      break;
  }
  const msg = String(fallback || "").trim();
  if (msg) return msg;
  return "처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.";
}

/** 직원 화면에 후보/조/원문 전화가 섞이지 않았는지 가드 (응답 객체 검사용) */
export function assertStaffSafeRequestView(request: unknown): boolean {
  if (request == null || typeof request !== "object") return true;
  const r = request as Record<string, unknown>;
  if ("candidateCaddyIds" in r) return false;
  if ("candidates" in r) return false;
  if ("phoneNormalized" in r) return false;
  if ("phone" in r && typeof r.phone === "string" && !String(r.phone).includes("*")) {
    // 원문처럼 보이는 phone 필드 금지 (마스킹은 maskedPhone만)
    return false;
  }
  return true;
}

/** 관리자 승인 큐 — 후보 1명이어도 자동 선택/자동 승인 금지 */
export function initialAdminSelectedCaddyId(
  _candidateCount: number
): number | null {
  return null;
}

/** API error code → 관리자용 한국어 안내 */
export function adminLinkErrorMessage(
  code: string | null | undefined,
  fallback?: string | null
): string {
  const c = String(code || "").trim();
  switch (c) {
    case "not_pending":
      return "대기 중인 요청만 처리할 수 있습니다. 목록을 새로고침해 주세요.";
    case "caddy_not_in_candidates":
      return "선택한 캐디가 이 요청의 후보에 없습니다.";
    case "caddy_not_active":
      return "ACTIVE 캐디만 승인할 수 있습니다.";
    case "caddy_already_linked":
      return "이미 다른 계정에 연결된 캐디입니다.";
    case "phone_duplicate":
      return "이미 다른 캐디에 등록된 휴대폰번호입니다.";
    case "phone_conflict":
      return "선택한 캐디에 다른 휴대폰번호가 이미 등록되어 있습니다.";
    case "already_linked":
      return "해당 계정은 이미 캐디에 연결되어 있습니다.";
    case "not_linkable_user":
      return "연결할 수 없는 계정입니다. (Kakao 캐디만 승인 가능)";
    case "not_found":
      return "요청을 찾을 수 없습니다. 목록을 새로고침해 주세요.";
    case "caddy_not_found":
      return "선택한 캐디를 찾을 수 없습니다.";
    case "unauthorized":
      return "관리자 로그인이 필요합니다.";
    default:
      break;
  }
  const msg = String(fallback || "").trim();
  if (msg) return msg;
  return "처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.";
}

/** 관리자 큐 표시용 — phoneNormalized / nickname / email 금지 */
export function assertAdminQueueSafeView(request: unknown): boolean {
  if (request == null || typeof request !== "object") return false;
  const r = request as Record<string, unknown>;
  if ("phoneNormalized" in r) return false;
  if (typeof r.phone === "string" && !String(r.phone).includes("*")) return false;
  if ("nickname" in r || "email" in r) return false;
  if (!("maskedPhone" in r)) return false;
  if (!Array.isArray(r.candidates)) return false;
  const user = r.user as Record<string, unknown> | undefined;
  if (user && ("nickname" in user || "email" in user)) return false;
  return true;
}
