/**
 * Assignments date-bundle client guards / labels.
 * Server Prisma/Sheet loaders는 여기로 import하지 않는다.
 */

import { isCurrentLoadGen } from "@/lib/pendingLoad";

export function shouldApplyAssignmentsDateBundle(input: {
  requestGen: number;
  latestGen: number;
  payloadDate?: string | null;
  selectedDate: string;
  cancelled?: boolean;
}): boolean {
  if (input.cancelled) return false;
  if (!isCurrentLoadGen(input.requestGen, input.latestGen)) return false;
  return input.payloadDate === input.selectedDate;
}

export const DATE_BUNDLE_SECTION_LABELS: Record<string, string> = {
  availability: "가용",
  opsDuty: "당번",
  offOverrides: "휴무 수정",
  unavailables: "병가/결근",
  thirdWeeklyStart: "3부반 시작조",
  published: "게시본",
  specialDuties: "특수근무",
  specialSupports: "특수지원",
  boardPreview: "배치표 알림",
};

export function dateBundleSectionWarnings(
  errors: Record<string, { error?: string } | undefined> | null | undefined
): string[] {
  if (!errors) return [];
  const lines: string[] = [];
  for (const [key, value] of Object.entries(errors)) {
    if (key === "draft" || !value?.error) continue;
    const label = DATE_BUNDLE_SECTION_LABELS[key] || key;
    lines.push(`${label}: ${value.error}`);
  }
  return lines;
}
