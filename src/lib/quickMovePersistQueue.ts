/**
 * 연속 quick MOVE persist queue 정책.
 * 서버 write는 직렬. 중간 실패 시 이후 queued move는 적용하지 않는다.
 */
import type { AssignmentDraft } from "@/lib/assignmentDraft";

export const TEAM_MOVE_QUEUE_STOPPED_TOAST =
  "이동을 저장하지 못했습니다. 이후 대기 중인 이동은 적용하지 않았습니다.";

export function shouldRunQueuedPersist(
  capturedGen: number,
  currentGen: number
): boolean {
  return capturedGen === currentGen;
}

export function bumpPersistGeneration(currentGen: number): number {
  return currentGen + 1;
}

export function rollbackDraftAfterQueuedMoveFailure(input: {
  lastSuccessfulDraft: AssignmentDraft | null | undefined;
  failedMoveRollbackDraft: AssignmentDraft;
}): AssignmentDraft {
  return input.lastSuccessfulDraft ?? input.failedMoveRollbackDraft;
}
