/**
 * 채팅 세션 폐기 알림 요약 타입·표시 문구(순수 모듈: 클라이언트 번들에서도 안전, env/secret 접근 없음).
 */

/** 일괄 폐기 알림 요약(개수만, 식별자 없음). */
export type ChatRevokeBulkStatus =
  | "none" // 알림 대상 계정 없음(연결된 계정이 없는 캐디)
  | "ok" // 모두 전송 성공
  | "not_configured" // Worker 주소/내부 인증 설정 없음 → 전송 안 됨(성공 아님)
  | "partial" // 일부 실패·미전송
  | "failed" // 전부 실패·미전송
  | "unknown"; // 알림 처리 중 예외·대상 조회 실패 → 미완료 건수 확정 불가(성공 아님, 0 으로 표시하지 않음)
export type ChatRevokeBulkSummary = {
  status: ChatRevokeBulkStatus;
  /** status==="unknown" 이면 아래 개수는 확정값이 아님(표시·집계에 쓰지 말 것). */
  targets: number;
  notified: number;
  failed: number;
  notConfigured: number;
  deadlineSkipped: number;
};

/** 미완료 건수(확정 불가면 null). none/ok → 0. */
export function chatRevokePendingCount(rv: ChatRevokeBulkSummary | null | undefined): number | null {
  if (!rv) return 0;
  if (rv.status === "unknown") return null;
  if (rv.status === "ok" || rv.status === "none") return 0;
  return rv.failed + rv.notConfigured + rv.deadlineSkipped;
}

/** CSV/XLSX 공통 성공 메시지 꼬리. 알림 성공·대상 없음이면 빈 문자열(기존 메시지 유지). */
export function chatRevokePendingSuffix(rv: ChatRevokeBulkSummary | null | undefined): string {
  if (!rv || rv.status === "ok" || rv.status === "none") return "";
  const n = chatRevokePendingCount(rv);
  const what = n == null ? "채팅 접속 종료 알림 미완료(건수 확인 불가)" : `채팅 접속 종료 알림 미완료 ${n}건`;
  return ` (${what} — 해당 계정의 새 접속은 차단됨)`;
}
