/**
 * 기존 명단 import preview에서 연락처 적재 요약을 파생한다.
 * import 엔진을 복제하지 않는다.
 */

export type ContactPreviewIssue = {
  kind?: string | null;
};

export type ContactPreviewLine = {
  action?: string | null;
  reason?: string | null;
  phoneChanged?: boolean | null;
  nextMaskedPhone?: string | null;
  maskedPhone?: string | null;
};

export type ContactPreviewInput = {
  summary?: {
    inputPeople?: number;
    update?: number;
    create?: number;
    unchanged?: number;
  } | null;
  lines?: ContactPreviewLine[] | null;
  needsReview?: Array<{ reason?: string | null }> | null;
  phoneIssues?: ContactPreviewIssue[] | null;
};

export type RosterImportContactSummary = {
  total: number;
  withPhone: number;
  matched: number;
  unmatched: number;
  homonyms: number;
  phoneInvalid: number;
  phoneDuplicate: number;
};

function isInputLine(line: ContactPreviewLine): boolean {
  return line.action !== "missingInImport";
}

function lineHasPhone(line: ContactPreviewLine): boolean {
  return Boolean(
    line.nextMaskedPhone || line.maskedPhone || line.phoneChanged
  );
}

export function rosterImportContactSummary(
  preview: ContactPreviewInput | null | undefined
): RosterImportContactSummary {
  const summary = preview?.summary ?? {};
  const lines = Array.isArray(preview?.lines) ? preview.lines : [];
  const inputLines = lines.filter(isInputLine);
  const review = Array.isArray(preview?.needsReview)
    ? preview.needsReview
    : lines.filter((line) => line.action === "needsReview");
  const issues = Array.isArray(preview?.phoneIssues) ? preview.phoneIssues : [];

  return {
    total: Number(summary.inputPeople) || inputLines.length,
    withPhone: inputLines.filter(lineHasPhone).length,
    matched: (Number(summary.update) || 0) + (Number(summary.unchanged) || 0),
    unmatched: Number(summary.create) || 0,
    homonyms: review.filter((row) =>
      String(row.reason ?? "").includes("동명이인")
    ).length,
    phoneInvalid: issues.filter((issue) => issue.kind === "invalid").length,
    phoneDuplicate: issues.filter((issue) =>
      String(issue.kind ?? "").startsWith("duplicate")
    ).length,
  };
}
