/**
 * 명단 반영(커밋 완료) 이후 감사 기록 보호.
 * - 커밋된 반영은 감사 기록 실패로 "반영 실패"가 되지 않는다.
 * - 실패는 조용히 무시하지 않고 auditRecorded=false 로 응답·화면에 경고한다.
 * - 로그에는 액션명·오류 종류(name)만 남긴다(식별자·이름·전화·secret·오류 원문 없음).
 */
export const ROSTER_IMPORT_AUDIT_MISSING_WARNING =
  " [경고: 감사 기록 저장 실패 — 명단은 반영되었습니다. 같은 파일을 다시 반영하지 말고 시스템 관리자에게 알려 주세요]";

export async function recordRosterImportAuditSafe(
  action: string,
  record: () => unknown | Promise<unknown>
): Promise<{ auditRecorded: boolean }> {
  try {
    await record();
    return { auditRecorded: true };
  } catch (e) {
    let kind = "Error";
    try {
      kind = e instanceof Error && /^[A-Za-z]{1,40}$/.test(e.name) ? e.name : "Error";
    } catch {
      /* ignore */
    }
    try {
      console.error("[AUDIT_MISSING]", action, `committed=true kind=${kind}`);
    } catch {
      /* ignore */
    }
    return { auditRecorded: false };
  }
}

/** 응답의 auditRecorded===false 일 때만 경고 꼬리(구 응답·true 는 빈 문자열). */
export function rosterImportAuditWarningSuffix(auditRecorded: unknown): string {
  return auditRecorded === false ? ROSTER_IMPORT_AUDIT_MISSING_WARNING : "";
}
