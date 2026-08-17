/**
 * Import Apply v2 — transaction / route timeout + 사용자 노출 메시지.
 * Preview 규칙·matching·partial commit과 무관.
 */

/**
 * Prisma interactive `$transaction` timeout (ms).
 * Prisma 기본값은 5000ms 이며, 대량 caddy.update() 순차 실행 시 부족하다.
 * audit 권장 ~60초. route maxDuration 보다 짧게 둔다.
 */
export const ROSTER_IMPORT_APPLY_TX_TIMEOUT_MS = 60_000;

/**
 * Transaction 연결을 얻기까지 대기 (ms).
 * Prisma 기본값 5000ms 보다 여유 있게 둔다.
 */
export const ROSTER_IMPORT_APPLY_TX_MAX_WAIT_MS = 10_000;

/**
 * Apply route `export const maxDuration` (seconds).
 * Next.js 15는 숫자 리터럴만 정적 추출하므로 route 파일에 `90`을 그대로 둔다.
 *
 * 선정:
 * - 프로젝트에 vercel.json / 기존 maxDuration 없음
 * - Next 15.5 App Router + Vercel Fluid(기본) 문서상 Hobby/Pro default·Hobby max = 300s
 * - 300s 이하이므로 현재 배포 한도와 호환
 * - tx timeout 60s + maxWait 10s + findMany/audit/응답 ~15s = 85s < 90s
 */
export const ROSTER_IMPORT_APPLY_ROUTE_MAX_DURATION_SECONDS = 90;

export const ROSTER_IMPORT_APPLY_FAILED_USER_MESSAGE =
  "적용 실패 — 데이터가 반영되지 않았습니다. 다시 시도해주세요.";

export function rosterImportApplySuccessMessage(result: {
  updated: number;
  created: number;
  phoneUpdated?: number;
}): string {
  const phone =
    typeof result.phoneUpdated === "number"
      ? ` · 전화 ${result.phoneUpdated}`
      : "";
  return `명단 반영 완료: 갱신 ${result.updated} · 신규 ${result.created}${phone}`;
}
