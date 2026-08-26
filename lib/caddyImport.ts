/**
 * 캐디 명단 import: parse → collapse → preview → apply
 *
 * 명단 해석:
 * - 1~12조 = primaryTeam
 * - 주중반/주말반/드라이빙 = extras (별도 분류)
 * - exact 동일 이름은 한 사람으로 합침 (primary + extras 보존)
 * - 이름 뒤 숫자 1/2는 제거하지 않음 (서로 다른 사람)
 *
 * 매칭:
 * - Production exact name 1:1만 자동 매칭, 기존 ID 유지
 * - phone은 매칭 키가 아님 (매칭 완료 후 부가 데이터)
 * - 철자 유사 / 숫자 표기 변경 = needsReview (자동 병합·생성 금지)
 * - missingInImport = 표시만 (자동 삭제 없음)
 *
 * CSV phone (optional):
 * - 헤더: phone | 휴대폰 | 전화번호 | mobile (대소문자 무시)
 * - 빈칸 = 기존 phone 유지 (삭제는 import로 불가)
 * - 컬럼 없음 = 기존 import와 동일
 * - XLSX는 phone 미지원
 *
 * 스키마 호환:
 * - Caddy.team = compatibleTeam(primaryTeam, extras)
 * - extras는 Preview/payload에만 포함. DB extras 컬럼 쓰기는 하지 않음.
 */

import {
  CaddyPhoneError,
  isPhoneUniqueViolation,
  maskKrMobile,
  normalizeKrMobile,
} from "./caddyPhone";
import {
  compatibleTeamFrom,
  EXTRA_FLAG_TEAMS,
  hasTrailingDigits,
  isExtraFlag,
  isNeedsReviewName,
  isPrimaryTeam,
  levenshtein,
  normalizePersonName,
  shouldTouchEmploymentStatus,
  stripTrailingDigits,
  type ExtraFlag,
} from "./caddyImportRules";
import { parseXlsxRosterBuffer } from "./caddyImportXlsx";

/** CSV phone 헤더 인식 (trim 후, 영문은 lower-case 비교) */
const PHONE_HEADER_ALIASES = ["phone", "휴대폰", "전화번호", "mobile"] as const;

export function isPhoneImportHeader(header: string): boolean {
  const trimmed = header.trim();
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();
  return PHONE_HEADER_ALIASES.some(
    (alias) => alias === trimmed || alias.toLowerCase() === lower
  );
}

export type ImportRow = {
  name: string;
  team: string;
  /** 원본 행 번호(1-based data row, 헤더 제외) — XLSX는 파서 seq */
  rowNumber: number;
  raw?: Record<string, string>;
  /**
   * CSV only: phone 컬럼이 있을 때만 설정 (빈 칸이면 "").
   * undefined = phone 컬럼 없음 (XLSX 포함).
   */
  phoneRaw?: string;
};

export type PhoneIntentKind =
  | "absent"
  | "blank"
  | "set"
  | "invalid"
  | "conflict";

/** XLSX/CSV 칸을 exact name 기준으로 합친 고유 캐디 */
export type ImportPerson = {
  name: string;
  /** 1~12조. 없으면 extra-only */
  primaryTeam: string | null;
  extras: ExtraFlag[];
  /** 기존 Caddy.team과 호환되는 소속 문자열 */
  team: string;
  rowNumbers: number[];
  /** 원본 기재 위치(조/분류) */
  sourceTeams: string[];
  /** exact 이름이 여러 칸에 있어 병합됨 */
  mergedFromDuplicateCells: boolean;
  /** phone 컬럼 존재 여부(해당 사람 행 기준) */
  phoneColumnPresent: boolean;
  phoneIntent: PhoneIntentKind;
  /** preview 공개용 — 전체번호 없음 */
  maskedPhone: string | null;
};

/** collapse 내부용 (전체번호는 preview 공개 객체에 넣지 않음) */
type ImportPersonInternal = ImportPerson & {
  phoneNormalized: string | null;
  phoneErrorMessage?: string;
};

export type ExistingCaddy = {
  id: number;
  name: string;
  team: string;
  status?: string | null;
  /** 향후 스키마 — 현재 Preview에서는 항상 []로 취급 */
  extras?: string[] | null;
  phoneNormalized?: string | null;
};

export type PhoneIssueKind =
  | "invalid"
  | "duplicate_in_file"
  | "duplicate_in_db"
  | "conflict_in_person";

export type PreviewPhoneIssue = {
  kind: PhoneIssueKind;
  name: string;
  id: number | null;
  maskedPhone: string | null;
  message: string;
  otherName?: string;
  otherId?: number;
};

type PhonePreviewFields = {
  teamChanged: boolean;
  phoneChanged: boolean;
  phoneOnlyUpdate: boolean;
  currentMaskedPhone: string | null;
  maskedPhone: string | null;
  phoneIssue: PhoneIssueKind | null;
};

export type PreviewUpdate = {
  id: number;
  name: string;
  currentTeam: string;
  nextTeam: string;
  primaryTeam: string | null;
  currentExtras: string[];
  nextExtras: ExtraFlag[];
  /** team은 동일하고 extras만 추가/변경 */
  extrasOnly: boolean;
} & PhonePreviewFields;

export type PreviewPhoneOnlyUpdate = {
  id: number;
  name: string;
  team: string;
  primaryTeam: string | null;
  extras: ExtraFlag[];
} & PhonePreviewFields;

export type PreviewUnchanged = {
  id: number;
  name: string;
  team: string;
  primaryTeam: string | null;
  extras: ExtraFlag[];
} & PhonePreviewFields;

export type PreviewCreate = {
  name: string;
  team: string;
  primaryTeam: string | null;
  extras: ExtraFlag[];
  rowNumber: number;
  phoneChanged: boolean;
  maskedPhone: string | null;
  phoneIssue: PhoneIssueKind | null;
};

export type PreviewNeedsReview = {
  name: string;
  team: string;
  primaryTeam: string | null;
  extras: ExtraFlag[];
  rowNumber: number;
  reason: string;
  candidateIds?: number[];
  maskedPhone?: string | null;
  phoneIssue?: PhoneIssueKind | null;
};

export type PreviewMissing = {
  id: number;
  name: string;
  team: string;
  currentMaskedPhone?: string | null;
};

export type PreviewAction =
  | "update"
  | "phoneOnlyUpdate"
  | "unchanged"
  | "create"
  | "needsReview"
  | "missingInImport";

export type PreviewLine = {
  action: PreviewAction;
  id: number | null;
  name: string;
  currentTeam: string | null;
  nextTeam: string | null;
  primaryTeam?: string | null;
  extras?: string[];
  reason?: string;
  teamChanged?: boolean;
  phoneChanged?: boolean;
  phoneOnlyUpdate?: boolean;
  currentMaskedPhone?: string | null;
  maskedPhone?: string | null;
  phoneIssue?: PhoneIssueKind | null;
};

export type ApplyPayload = {
  /**
   * team 반영 + 선택적 phone(normalized).
   * phone 키 생략 = 기존 phone 유지. import로 null 삭제는 금지.
   */
  updates: Array<{
    id: number;
    team: string;
    extras: ExtraFlag[];
    phone?: string;
  }>;
  creates: Array<{
    name: string;
    team: string;
    extras: ExtraFlag[];
    phone?: string;
  }>;
};

export type ImportPreview = {
  summary: {
    uniqueImportPeople: number;
    rawImportRows: number;
    mergedDuplicatePeople: number;
    /** team 또는 extras 변경 (기존 의미 유지). phone-only는 포함하지 않음 */
    update: number;
    /** team·extras·phone 모두 변경 없음 */
    unchanged: number;
    new: number;
    needsReview: number;
    missingInImport: number;
    /** team 문자열 변경 건수 */
    teamChanged: number;
    /** phone 설정/변경 건수 (phone-only + team/extras와 동시 변경) */
    phoneChanged: number;
    /** team·extras 동일, phone만 변경 */
    phoneOnlyUpdate: number;
    phoneColumnPresent: boolean;
    phoneIssues: number;
    applyBlockedByPhone: boolean;
    /** create + exact-matched(update∪phoneOnly∪unchanged) 고유 인원 */
    createPlusMatched: number;
    /** create+matched+needsReview == uniqueImportPeople */
    partitionMatchesUnique: boolean;
    /** create+matched == uniqueImportPeople (needsReview 있으면 false) */
    createPlusMatchedEqualsUnique: boolean;
    expectedTotalAfterApply: number;
    extrasHeadcount: {
      주중반: number;
      주말반: number;
      드라이빙: number;
    };
  };
  people: ImportPerson[];
  mergedDuplicates: Array<{
    name: string;
    primaryTeam: string | null;
    extras: ExtraFlag[];
    sourceTeams: string[];
  }>;
  updates: PreviewUpdate[];
  phoneOnlyUpdates: PreviewPhoneOnlyUpdate[];
  unchanged: PreviewUnchanged[];
  creates: PreviewCreate[];
  needsReview: PreviewNeedsReview[];
  missingInImport: PreviewMissing[];
  phoneIssues: PreviewPhoneIssue[];
  lines: PreviewLine[];
  applyPayload: ApplyPayload;
  touchesEmploymentStatus: false;
  schemaProposal: {
    keepTeamField: true;
    proposedExtraFlagsField: "Caddy.extraFlags String[] (not migrated)";
    note: string;
  };
};

export type ApplyResult = {
  updated: number;
  created: number;
  skippedNeedsReview: number;
  createdIds: number[];
  phoneUpdated: number;
};

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function parseCsvText(text: string): ImportRow[] {
  const cleaned = text.replace(/^\uFEFF/, "").trim();
  if (!cleaned) return [];

  const lines = cleaned.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];

  const headers = splitCsvLine(lines[0]).map((h) => h.trim());
  const teamIdx = headers.findIndex((h) => h.toLowerCase() === "team");
  const nameIdx = headers.findIndex((h) => h.toLowerCase() === "name");
  if (teamIdx === -1 || nameIdx === -1) {
    throw new Error("CSV 헤더에 team, name 컬럼이 필요합니다.");
  }
  const phoneIdx = headers.findIndex((h) => isPhoneImportHeader(h));
  const phoneColumnPresent = phoneIdx !== -1;

  const rows: ImportRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = splitCsvLine(lines[i]);
    const name = (parts[nameIdx] ?? "").trim();
    const team = (parts[teamIdx] ?? "").trim();
    if (!name || !team) continue;
    const raw: Record<string, string> = {};
    headers.forEach((h, idx) => {
      raw[h] = parts[idx] ?? "";
    });
    const row: ImportRow = { name, team, rowNumber: i, raw };
    if (phoneColumnPresent) {
      row.phoneRaw = (parts[phoneIdx] ?? "").trim();
    }
    rows.push(row);
  }
  return rows;
}

/**
 * CSV(team,name[,phone]) 또는 XLSX/XLS(1~12조 가로 + 카트/성명) 파싱.
 * - 칸 단위 ImportRow 반환 (동일 이름 중복 칸 포함)
 * - XLSX는 phone 미지원 (phoneRaw 미설정)
 * - 고유 인원으로 쓰려면 collapseImportRowsToPeople 사용
 */
export function parseImportFile(
  buffer: Buffer | string,
  filename = "import.csv"
): ImportRow[] {
  const lower = filename.toLowerCase();
  const isExcel = lower.endsWith(".xlsx") || lower.endsWith(".xls");

  if (isExcel) {
    if (typeof buffer === "string") {
      throw new Error("XLSX/XLS는 binary Buffer로 업로드해야 합니다.");
    }
    return parseXlsxRosterBuffer(buffer, filename);
  }

  const text = typeof buffer === "string" ? buffer : buffer.toString("utf8");
  return parseCsvText(text);
}

function sortExtras(flags: Iterable<string>): ExtraFlag[] {
  const set = new Set<string>();
  for (const f of flags) {
    const compact = f.trim().replace(/\s+/g, "");
    if (isExtraFlag(compact)) set.add(compact);
  }
  return EXTRA_FLAG_TEAMS.filter((f) => set.has(f));
}

function resolvePhoneFromRaws(raws: string[]): {
  intent: PhoneIntentKind;
  phoneNormalized: string | null;
  maskedPhone: string | null;
  errorMessage?: string;
} {
  const nonEmpty = raws.map((r) => r.trim()).filter((r) => r.length > 0);
  if (nonEmpty.length === 0) {
    return { intent: "blank", phoneNormalized: null, maskedPhone: null };
  }

  const normalized: string[] = [];
  for (const raw of nonEmpty) {
    try {
      normalized.push(normalizeKrMobile(raw));
    } catch (e) {
      const msg =
        e instanceof CaddyPhoneError
          ? e.message
          : "유효한 휴대폰번호가 아닙니다.";
      return {
        intent: "invalid",
        phoneNormalized: null,
        maskedPhone: null,
        errorMessage: msg,
      };
    }
  }

  const uniq = [...new Set(normalized)];
  if (uniq.length > 1) {
    return {
      intent: "conflict",
      phoneNormalized: null,
      maskedPhone: null,
      errorMessage: "동일 이름에 서로 다른 휴대폰번호가 기재되어 있습니다.",
    };
  }

  const phoneNormalized = uniq[0];
  return {
    intent: "set",
    phoneNormalized,
    maskedPhone: maskKrMobile(phoneNormalized),
  };
}

/**
 * exact name으로 칸을 고유 캐디로 합친다.
 * - 1~12조 → primaryTeam (복수 primary면 충돌 → 첫 값 유지, sourceTeams에 기록)
 * - 주중/주말/드라이빙 → extras
 * - 이름 뒤 숫자는 제거하지 않음
 * - CSV phoneRaw가 있으면 병합·정규화 (XLSX는 absent)
 */
export function collapseImportRowsToPeople(
  rows: ImportRow[]
): ImportPersonInternal[] {
  type Acc = {
    name: string;
    primaryTeam: string | null;
    extras: Set<string>;
    rowNumbers: number[];
    sourceTeams: string[];
    phoneRaws: string[];
    phoneColumnPresent: boolean;
  };
  const byName = new Map<string, Acc>();

  for (const row of rows) {
    const name = normalizePersonName(row.name);
    if (!name) continue;
    const team = row.team.trim().replace(/\s+/g, "");
    if (!team) continue;

    let acc = byName.get(name);
    if (!acc) {
      acc = {
        name,
        primaryTeam: null,
        extras: new Set(),
        rowNumbers: [],
        sourceTeams: [],
        phoneRaws: [],
        phoneColumnPresent: false,
      };
      byName.set(name, acc);
    }
    acc.rowNumbers.push(row.rowNumber);
    if (!acc.sourceTeams.includes(team)) acc.sourceTeams.push(team);

    if (row.phoneRaw !== undefined) {
      acc.phoneColumnPresent = true;
      acc.phoneRaws.push(row.phoneRaw);
    }

    if (isPrimaryTeam(team)) {
      if (!acc.primaryTeam) acc.primaryTeam = team;
      // 서로 다른 1~12조에 동시 기재는 데이터상 없어야 함. 있으면 첫 primary 유지.
    } else if (isExtraFlag(team)) {
      acc.extras.add(team);
    } else {
      // 알 수 없는 라벨은 primary처럼 team 호환값으로 취급
      if (!acc.primaryTeam) acc.primaryTeam = team;
    }
  }

  const people: ImportPersonInternal[] = [];
  for (const acc of byName.values()) {
    const extras = sortExtras(acc.extras);
    const team = compatibleTeamFrom(acc.primaryTeam, extras);
    let phoneIntent: PhoneIntentKind = "absent";
    let phoneNormalized: string | null = null;
    let maskedPhone: string | null = null;
    let phoneErrorMessage: string | undefined;

    if (acc.phoneColumnPresent) {
      const resolved = resolvePhoneFromRaws(acc.phoneRaws);
      phoneIntent = resolved.intent;
      phoneNormalized = resolved.phoneNormalized;
      maskedPhone = resolved.maskedPhone;
      phoneErrorMessage = resolved.errorMessage;
    }

    people.push({
      name: acc.name,
      primaryTeam: acc.primaryTeam,
      extras,
      team,
      rowNumbers: acc.rowNumbers,
      sourceTeams: acc.sourceTeams,
      mergedFromDuplicateCells: acc.sourceTeams.length > 1,
      phoneColumnPresent: acc.phoneColumnPresent,
      phoneIntent,
      phoneNormalized,
      maskedPhone,
      phoneErrorMessage,
    });
  }

  // 안정 정렬: primary 조 숫자 → extra → 이름
  const teamOrder = (p: ImportPerson) => {
    if (p.primaryTeam) {
      const n = Number(p.primaryTeam.replace("조", ""));
      return Number.isFinite(n) ? n : 50;
    }
    if (p.extras[0] === "주중반") return 100;
    if (p.extras[0] === "주말반") return 101;
    if (p.extras[0] === "드라이빙") return 102;
    return 999;
  };
  people.sort(
    (a, b) =>
      teamOrder(a) - teamOrder(b) || a.name.localeCompare(b.name, "ko")
  );
  return people;
}

function toPublicPerson(p: ImportPersonInternal): ImportPerson {
  return {
    name: p.name,
    primaryTeam: p.primaryTeam,
    extras: p.extras,
    team: p.team,
    rowNumbers: p.rowNumbers,
    sourceTeams: p.sourceTeams,
    mergedFromDuplicateCells: p.mergedFromDuplicateCells,
    phoneColumnPresent: p.phoneColumnPresent,
    phoneIntent: p.phoneIntent,
    maskedPhone: p.maskedPhone,
  };
}

export function buildPreviewLines(
  preview: Omit<ImportPreview, "lines" | "schemaProposal">
): PreviewLine[] {
  const lines: PreviewLine[] = [];

  for (const u of preview.updates) {
    lines.push({
      action: "update",
      id: u.id,
      name: u.name,
      currentTeam: u.currentTeam,
      nextTeam: u.nextTeam,
      primaryTeam: u.primaryTeam,
      extras: u.nextExtras,
      teamChanged: u.teamChanged,
      phoneChanged: u.phoneChanged,
      phoneOnlyUpdate: false,
      currentMaskedPhone: u.currentMaskedPhone,
      maskedPhone: u.maskedPhone,
      phoneIssue: u.phoneIssue,
      reason: u.extrasOnly
        ? `extras 변경 예정: [${u.nextExtras.join(", ")}] (team 유지, DB extras 미적용)`
        : u.nextExtras.length
          ? `team ${u.currentTeam}→${u.nextTeam}, extras=[${u.nextExtras.join(", ")}]`
          : undefined,
    });
  }
  for (const u of preview.phoneOnlyUpdates) {
    lines.push({
      action: "phoneOnlyUpdate",
      id: u.id,
      name: u.name,
      currentTeam: u.team,
      nextTeam: u.team,
      primaryTeam: u.primaryTeam,
      extras: u.extras,
      teamChanged: false,
      phoneChanged: true,
      phoneOnlyUpdate: true,
      currentMaskedPhone: u.currentMaskedPhone,
      maskedPhone: u.maskedPhone,
      phoneIssue: u.phoneIssue,
      reason: `phone ${u.currentMaskedPhone ?? "—"}→${u.maskedPhone ?? "—"} (team 유지)`,
    });
  }
  for (const u of preview.unchanged) {
    lines.push({
      action: "unchanged",
      id: u.id,
      name: u.name,
      currentTeam: u.team,
      nextTeam: u.team,
      primaryTeam: u.primaryTeam,
      extras: u.extras,
      teamChanged: false,
      phoneChanged: false,
      phoneOnlyUpdate: false,
      currentMaskedPhone: u.currentMaskedPhone,
      maskedPhone: u.maskedPhone,
      phoneIssue: u.phoneIssue,
    });
  }
  for (const c of preview.creates) {
    lines.push({
      action: "create",
      id: null,
      name: c.name,
      currentTeam: null,
      nextTeam: c.team,
      primaryTeam: c.primaryTeam,
      extras: c.extras,
      phoneChanged: c.phoneChanged,
      maskedPhone: c.maskedPhone,
      phoneIssue: c.phoneIssue,
    });
  }
  for (const r of preview.needsReview) {
    const ids = r.candidateIds ?? [];
    lines.push({
      action: "needsReview",
      id: ids.length === 1 ? ids[0] : null,
      name: r.name,
      currentTeam: null,
      nextTeam: r.team,
      primaryTeam: r.primaryTeam,
      extras: r.extras,
      maskedPhone: r.maskedPhone ?? null,
      phoneIssue: r.phoneIssue ?? null,
      reason:
        ids.length > 0
          ? `${r.reason} (후보 id: ${ids.join(", ")})`
          : r.reason,
    });
  }
  for (const m of preview.missingInImport) {
    lines.push({
      action: "missingInImport",
      id: m.id,
      name: m.name,
      currentTeam: m.team,
      nextTeam: null,
      currentMaskedPhone: m.currentMaskedPhone ?? null,
      reason: "최신 명단에 없음 — 자동 삭제 없음",
    });
  }

  const order: Record<PreviewAction, number> = {
    needsReview: 0,
    update: 1,
    phoneOnlyUpdate: 2,
    create: 3,
    unchanged: 4,
    missingInImport: 5,
  };
  return lines.sort((a, b) => {
    const d = order[a.action] - order[b.action];
    if (d !== 0) return d;
    return (a.id ?? 1e12) - (b.id ?? 1e12) || a.name.localeCompare(b.name, "ko");
  });
}

function groupByName(caddies: ExistingCaddy[]): Map<string, ExistingCaddy[]> {
  const map = new Map<string, ExistingCaddy[]>();
  for (const c of caddies) {
    const key = normalizePersonName(c.name);
    const list = map.get(key) ?? [];
    list.push(c);
    map.set(key, list);
  }
  return map;
}

function existingExtras(c: ExistingCaddy): string[] {
  return sortExtras(c.extras ?? []);
}

function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sb = new Set(b);
  return a.every((x) => sb.has(x));
}

function findNumberVariantCandidates(
  personName: string,
  existing: ExistingCaddy[]
): ExistingCaddy[] {
  const base = stripTrailingDigits(personName);
  if (!base) return [];
  return existing.filter((e) => {
    const en = normalizePersonName(e.name);
    if (en === normalizePersonName(personName)) return false;
    return stripTrailingDigits(en) === base;
  });
}

function findTypoCandidates(
  personName: string,
  unmatchedExisting: ExistingCaddy[]
): ExistingCaddy[] {
  const n = normalizePersonName(personName);
  return unmatchedExisting.filter((e) => {
    const en = normalizePersonName(e.name);
    if (en === n) return false;
    // 숫자 표기 차이는 별도 규칙
    if (stripTrailingDigits(en) === stripTrailingDigits(n) && en !== n) {
      return false;
    }
    return levenshtein(n, en) === 1;
  });
}

type MatchedBucket = {
  person: ImportPersonInternal;
  cur: ExistingCaddy;
  teamChanged: boolean;
  extrasChanged: boolean;
  extrasOnly: boolean;
};

/**
 * 읽기 전용 preview. DB 쓰지 않음.
 */
export function buildImportPreview(
  importRows: ImportRow[],
  existing: ExistingCaddy[]
): ImportPreview {
  void shouldTouchEmploymentStatus();

  const peopleInternal = collapseImportRowsToPeople(importRows);
  const phoneColumnPresent = peopleInternal.some((p) => p.phoneColumnPresent);
  const byName = groupByName(existing);
  const matchedIds = new Set<number>();
  const reviewedImportNames = new Set<string>();

  const matched: MatchedBucket[] = [];
  const createsDraft: ImportPersonInternal[] = [];
  const needsReview: PreviewNeedsReview[] = [];

  // Pass 1: exact / explicit blocklist / prod duplicates
  const deferred: ImportPersonInternal[] = [];

  for (const person of peopleInternal) {
    const key = normalizePersonName(person.name);

    if (isNeedsReviewName(person.name)) {
      const candidates = [
        ...(byName.get(key) ?? []),
        ...findNumberVariantCandidates(person.name, existing),
      ];
      const uniq = new Map(candidates.map((c) => [c.id, c]));
      needsReview.push({
        name: person.name,
        team: person.team,
        primaryTeam: person.primaryTeam,
        extras: person.extras,
        rowNumber: person.rowNumbers[0] ?? 0,
        reason: "동명이인/번호 표기 확인 필요 — 자동 매칭·신규 생성 금지",
        candidateIds: [...uniq.keys()],
        maskedPhone: person.maskedPhone,
        phoneIssue: null,
      });
      reviewedImportNames.add(key);
      continue;
    }

    const candidates = byName.get(key) ?? [];
    if (candidates.length > 1) {
      needsReview.push({
        name: person.name,
        team: person.team,
        primaryTeam: person.primaryTeam,
        extras: person.extras,
        rowNumber: person.rowNumbers[0] ?? 0,
        reason: `동명이인 ${candidates.length}명 — 자동 매칭 불가`,
        candidateIds: candidates.map((c) => c.id),
        maskedPhone: person.maskedPhone,
        phoneIssue: null,
      });
      reviewedImportNames.add(key);
      continue;
    }

    if (candidates.length === 1) {
      const cur = candidates[0];
      matchedIds.add(cur.id);
      const curExtras = existingExtras(cur);
      const nextExtras = person.extras;
      const teamChanged = cur.team !== person.team;
      const extrasChanged = !sameStringSet(curExtras, nextExtras);
      matched.push({
        person,
        cur,
        teamChanged,
        extrasChanged,
        extrasOnly: !teamChanged && extrasChanged,
      });
      continue;
    }

    deferred.push(person);
  }

  const unmatchedExisting = existing.filter((e) => !matchedIds.has(e.id));

  // Pass 2: number-variant / typo → needsReview, else create
  for (const person of deferred) {
    const key = normalizePersonName(person.name);
    const numCands = findNumberVariantCandidates(person.name, existing);
    if (numCands.length > 0) {
      needsReview.push({
        name: person.name,
        team: person.team,
        primaryTeam: person.primaryTeam,
        extras: person.extras,
        rowNumber: person.rowNumbers[0] ?? 0,
        reason: `숫자 표기 변경 의심(base="${stripTrailingDigits(person.name)}") — 자동 병합·생성 금지`,
        candidateIds: numCands.map((c) => c.id),
        maskedPhone: person.maskedPhone,
        phoneIssue: null,
      });
      reviewedImportNames.add(key);
      continue;
    }

    const typoCands = findTypoCandidates(person.name, unmatchedExisting);
    if (typoCands.length > 0) {
      needsReview.push({
        name: person.name,
        team: person.team,
        primaryTeam: person.primaryTeam,
        extras: person.extras,
        rowNumber: person.rowNumbers[0] ?? 0,
        reason: `철자 유사(거리 1) 후보 있음 — 자동 매칭·생성 금지`,
        candidateIds: typoCands.map((c) => c.id),
        maskedPhone: person.maskedPhone,
        phoneIssue: null,
      });
      reviewedImportNames.add(key);
      continue;
    }

    createsDraft.push(person);
  }

  // --- phone validation (name-matched / create candidates only) ---
  const phoneIssues: PreviewPhoneIssue[] = [];
  const blockedNames = new Set<string>();

  const phoneOwnersInFile = new Map<
    string,
    { name: string; id: number | null }[]
  >();

  const considerSetPhone = (
    person: ImportPersonInternal,
    id: number | null
  ) => {
    if (person.phoneIntent === "invalid") {
      phoneIssues.push({
        kind: "invalid",
        name: person.name,
        id,
        maskedPhone: null,
        message: person.phoneErrorMessage || "유효한 휴대폰번호가 아닙니다.",
      });
      blockedNames.add(normalizePersonName(person.name));
      return;
    }
    if (person.phoneIntent === "conflict") {
      phoneIssues.push({
        kind: "conflict_in_person",
        name: person.name,
        id,
        maskedPhone: null,
        message:
          person.phoneErrorMessage ||
          "동일 이름에 서로 다른 휴대폰번호가 기재되어 있습니다.",
      });
      blockedNames.add(normalizePersonName(person.name));
      return;
    }
    if (person.phoneIntent === "set" && person.phoneNormalized) {
      const list = phoneOwnersInFile.get(person.phoneNormalized) ?? [];
      list.push({ name: person.name, id });
      phoneOwnersInFile.set(person.phoneNormalized, list);
    }
  };

  for (const m of matched) {
    considerSetPhone(m.person, m.cur.id);
  }
  for (const person of createsDraft) {
    considerSetPhone(person, null);
  }

  for (const [phone, owners] of phoneOwnersInFile) {
    if (owners.length <= 1) continue;
    const masked = maskKrMobile(phone);
    for (const owner of owners) {
      const other = owners.find((o) => o.name !== owner.name) ?? owners[0];
      phoneIssues.push({
        kind: "duplicate_in_file",
        name: owner.name,
        id: owner.id,
        maskedPhone: masked,
        message: `파일 내 중복 번호 (${other.name})`,
        otherName: other.name,
        otherId: other.id ?? undefined,
      });
      blockedNames.add(normalizePersonName(owner.name));
    }
  }

  const dbPhoneOwner = new Map<string, ExistingCaddy>();
  for (const c of existing) {
    const p = c.phoneNormalized ?? null;
    if (p) dbPhoneOwner.set(p, c);
  }

  for (const m of matched) {
    if (m.person.phoneIntent !== "set" || !m.person.phoneNormalized) continue;
    if (blockedNames.has(normalizePersonName(m.person.name))) continue;
    const holder = dbPhoneOwner.get(m.person.phoneNormalized);
    if (holder && holder.id !== m.cur.id) {
      phoneIssues.push({
        kind: "duplicate_in_db",
        name: m.person.name,
        id: m.cur.id,
        maskedPhone: m.person.maskedPhone,
        message: `다른 캐디(id=${holder.id})가 이미 사용 중인 번호`,
        otherName: holder.name,
        otherId: holder.id,
      });
      blockedNames.add(normalizePersonName(m.person.name));
    }
  }

  for (const person of createsDraft) {
    if (person.phoneIntent !== "set" || !person.phoneNormalized) continue;
    if (blockedNames.has(normalizePersonName(person.name))) continue;
    const holder = dbPhoneOwner.get(person.phoneNormalized);
    if (holder) {
      phoneIssues.push({
        kind: "duplicate_in_db",
        name: person.name,
        id: null,
        maskedPhone: person.maskedPhone,
        message: `다른 캐디(id=${holder.id})가 이미 사용 중인 번호`,
        otherName: holder.name,
        otherId: holder.id,
      });
      blockedNames.add(normalizePersonName(person.name));
    }
  }

  const applyBlockedByPhone = phoneIssues.length > 0;

  // Blocked creates → needsReview (자동 create 금지)
  const creates: PreviewCreate[] = [];
  for (const person of createsDraft) {
    const key = normalizePersonName(person.name);
    if (blockedNames.has(key)) {
      const issue =
        phoneIssues.find((i) => normalizePersonName(i.name) === key) ?? null;
      needsReview.push({
        name: person.name,
        team: person.team,
        primaryTeam: person.primaryTeam,
        extras: person.extras,
        rowNumber: person.rowNumbers[0] ?? 0,
        reason: issue
          ? `휴대폰번호 문제(${issue.kind}) — 신규 생성 금지`
          : "휴대폰번호 문제 — 신규 생성 금지",
        maskedPhone: person.maskedPhone,
        phoneIssue: issue?.kind ?? "invalid",
      });
      reviewedImportNames.add(key);
      continue;
    }

    const phoneChanged = person.phoneIntent === "set";
    creates.push({
      name: person.name,
      team: person.team,
      primaryTeam: person.primaryTeam,
      extras: person.extras,
      rowNumber: person.rowNumbers[0] ?? 0,
      phoneChanged,
      maskedPhone: person.maskedPhone,
      phoneIssue: null,
    });
  }

  const updates: PreviewUpdate[] = [];
  const phoneOnlyUpdates: PreviewPhoneOnlyUpdate[] = [];
  const unchanged: PreviewUnchanged[] = [];

  for (const m of matched) {
    const { person, cur, teamChanged, extrasChanged, extrasOnly } = m;
    const key = normalizePersonName(person.name);
    const currentPhone = cur.phoneNormalized ?? null;
    const currentMaskedPhone = maskKrMobile(currentPhone);
    const blocked = blockedNames.has(key);
    const issue =
      phoneIssues.find((i) => normalizePersonName(i.name) === key)?.kind ??
      null;

    let phoneChanged = false;
    let nextMasked = currentMaskedPhone;
    let applyPhone: string | undefined;

    if (
      !blocked &&
      person.phoneIntent === "set" &&
      person.phoneNormalized &&
      person.phoneNormalized !== currentPhone
    ) {
      phoneChanged = true;
      nextMasked = person.maskedPhone;
      applyPhone = person.phoneNormalized;
    } else if (
      !blocked &&
      person.phoneIntent === "set" &&
      person.phoneNormalized &&
      person.phoneNormalized === currentPhone
    ) {
      // same number → no change
      nextMasked = currentMaskedPhone;
    } else if (person.phoneIntent === "blank" || person.phoneIntent === "absent") {
      nextMasked = currentMaskedPhone;
    } else if (blocked) {
      nextMasked = person.maskedPhone ?? currentMaskedPhone;
    }

    const rosterChanged = teamChanged || extrasChanged;
    const phoneFields: PhonePreviewFields = {
      teamChanged,
      phoneChanged,
      phoneOnlyUpdate: !rosterChanged && phoneChanged,
      currentMaskedPhone,
      maskedPhone: nextMasked,
      phoneIssue: issue,
    };

    if (rosterChanged) {
      updates.push({
        id: cur.id,
        name: cur.name,
        currentTeam: cur.team,
        nextTeam: person.team,
        primaryTeam: person.primaryTeam,
        currentExtras: existingExtras(cur),
        nextExtras: person.extras,
        extrasOnly,
        ...phoneFields,
        phoneOnlyUpdate: false,
      });
    } else if (phoneChanged) {
      phoneOnlyUpdates.push({
        id: cur.id,
        name: cur.name,
        team: cur.team,
        primaryTeam: person.primaryTeam,
        extras: person.extras,
        ...phoneFields,
        phoneOnlyUpdate: true,
      });
    } else {
      unchanged.push({
        id: cur.id,
        name: cur.name,
        team: cur.team,
        primaryTeam: person.primaryTeam,
        extras: person.extras,
        ...phoneFields,
        phoneChanged: false,
        phoneOnlyUpdate: false,
      });
    }

    // stash apply phone on person for payload build
    (person as ImportPersonInternal & { _applyPhone?: string })._applyPhone =
      applyPhone;
  }

  const missingInImport: PreviewMissing[] = existing
    .filter((c) => !matchedIds.has(c.id))
    .map((c) => ({
      id: c.id,
      name: c.name,
      team: c.team,
      currentMaskedPhone: maskKrMobile(c.phoneNormalized ?? null),
    }));

  // applyPayload: phone issues가 있으면 전체 apply 차단 (빈 payload)
  let applyPayload: ApplyPayload;
  if (applyBlockedByPhone) {
    applyPayload = { updates: [], creates: [] };
  } else {
    const payloadUpdates: ApplyPayload["updates"] = [];

    for (const m of matched) {
      const rosterChanged = m.teamChanged || m.extrasChanged;
      const applyPhone = (
        m.person as ImportPersonInternal & { _applyPhone?: string }
      )._applyPhone;
      if (!rosterChanged && !applyPhone) continue;
      payloadUpdates.push({
        id: m.cur.id,
        team: m.person.team,
        extras: m.person.extras,
        ...(applyPhone ? { phone: applyPhone } : {}),
      });
    }

    applyPayload = {
      updates: payloadUpdates,
      creates: creates.map((c) => {
        const person = createsDraft.find(
          (p) => normalizePersonName(p.name) === normalizePersonName(c.name)
        );
        const phone =
          person?.phoneIntent === "set" && person.phoneNormalized
            ? person.phoneNormalized
            : undefined;
        return {
          name: c.name,
          team: c.team,
          extras: c.extras,
          ...(phone ? { phone } : {}),
        };
      }),
    };
  }

  const mergedDuplicates = peopleInternal
    .filter((p) => p.mergedFromDuplicateCells && p.sourceTeams.length > 1)
    .map((p) => ({
      name: p.name,
      primaryTeam: p.primaryTeam,
      extras: p.extras,
      sourceTeams: p.sourceTeams,
    }));

  const countExtra = (flag: ExtraFlag) =>
    peopleInternal.filter((p) => p.extras.includes(flag)).length;

  const extrasHeadcountFinal = {
    주중반: countExtra("주중반"),
    주말반: countExtra("주말반"),
    드라이빙: countExtra("드라이빙"),
  };

  const matchedCount =
    updates.length + phoneOnlyUpdates.length + unchanged.length;
  const createPlusMatched = creates.length + matchedCount;
  const partitionCount = createPlusMatched + needsReview.length;
  const uniqueImportPeople = peopleInternal.length;

  const expectedTotalAfterApply = applyBlockedByPhone
    ? existing.length
    : existing.length + creates.length;

  const teamChangedCount = updates.filter((u) => u.teamChanged).length;
  const phoneChangedCount =
    updates.filter((u) => u.phoneChanged).length +
    phoneOnlyUpdates.length +
    creates.filter((c) => c.phoneChanged).length;

  const base = {
    summary: {
      uniqueImportPeople,
      rawImportRows: importRows.length,
      mergedDuplicatePeople: mergedDuplicates.length,
      update: updates.length,
      unchanged: unchanged.length,
      new: creates.length,
      needsReview: needsReview.length,
      missingInImport: missingInImport.length,
      teamChanged: teamChangedCount,
      phoneChanged: phoneChangedCount,
      phoneOnlyUpdate: phoneOnlyUpdates.length,
      phoneColumnPresent,
      phoneIssues: phoneIssues.length,
      applyBlockedByPhone,
      createPlusMatched,
      partitionMatchesUnique: partitionCount === uniqueImportPeople,
      createPlusMatchedEqualsUnique: createPlusMatched === uniqueImportPeople,
      expectedTotalAfterApply,
      extrasHeadcount: extrasHeadcountFinal,
    },
    people: peopleInternal.map(toPublicPerson),
    mergedDuplicates,
    updates,
    phoneOnlyUpdates,
    unchanged,
    creates,
    needsReview,
    missingInImport,
    phoneIssues,
    applyPayload,
    touchesEmploymentStatus: false as const,
  };

  void reviewedImportNames;
  void hasTrailingDigits;

  return {
    ...base,
    lines: buildPreviewLines(base),
    schemaProposal: {
      keepTeamField: true,
      proposedExtraFlagsField: "Caddy.extraFlags String[] (not migrated)",
      note: phoneColumnPresent
        ? "CSV phone 컬럼 인식. 빈칸=유지, 유효번호=설정. needsReview에는 phone 미적용. XLSX는 phone 미지원."
        : "Preview만 수행. team=primary 또는 extra-only 분류. extras는 payload에만 포함하며 DB에 쓰지 않음.",
    },
  };
}

type PrismaLike = {
  caddy: {
    update: (args: {
      where: { id: number };
      data: { team?: string; phoneNormalized?: string };
    }) => Promise<{
      id: number;
      name: string;
      team: string;
      phoneNormalized?: string | null;
    }>;
    create: (args: {
      data: { name: string; team: string; phoneNormalized?: string };
    }) => Promise<{
      id: number;
      name: string;
      team: string;
      phoneNormalized?: string | null;
    }>;
    findMany?: (args?: {
      select?: {
        id?: boolean;
        name?: boolean;
        team?: boolean;
        phoneNormalized?: boolean;
      };
    }) => Promise<ExistingCaddy[]>;
  };
  $transaction?: <T>(fn: (tx: PrismaLike) => Promise<T>) => Promise<T>;
};

export class CaddyImportApplyError extends Error {
  constructor(
    message: string,
    public status: number = 400,
    public code: string = "import_apply_error"
  ) {
    super(message);
    this.name = "CaddyImportApplyError";
  }
}

function assertNormalizedPhone(phone: string): string {
  // payload 값은 이미 normalize된 것을 기대하지만, apply에서 재검증
  return normalizeKrMobile(phone);
}

/**
 * apply: ID 유지 update + 신규 create만.
 * - team + optional phoneNormalized
 * - phone 키 생략 = 유지. null 삭제 금지
 * - needsReview 이름 create 거부
 * - 삭제/재생성/employmentStatus 변경 없음
 * - phone 중복은 apply 전 재검증 + P2002 백스톱
 */
export async function applyImportPayload(
  payload: ApplyPayload,
  prisma: PrismaLike,
  options?: {
    rejectNeedsReviewNames?: boolean;
    existingForGuard?: ExistingCaddy[];
  }
): Promise<ApplyResult> {
  void shouldTouchEmploymentStatus();

  const reject = options?.rejectNeedsReviewNames !== false;

  for (const c of payload.creates) {
    if (reject && isNeedsReviewName(c.name)) {
      throw new CaddyImportApplyError(
        `needsReview 이름은 신규 생성할 수 없습니다: ${c.name}`
      );
    }
  }

  // normalize + in-payload duplicate check
  const normalizedUpdates: Array<{
    id: number;
    team: string;
    phone?: string;
  }> = [];
  const normalizedCreates: Array<{
    name: string;
    team: string;
    phone?: string;
  }> = [];
  const phoneToOwner = new Map<string, string>();

  for (const u of payload.updates) {
    let phone: string | undefined;
    if (u.phone !== undefined && u.phone !== null) {
      if (String(u.phone).trim() === "") {
        throw new CaddyImportApplyError(
          "import로는 휴대폰번호를 삭제할 수 없습니다.",
          400,
          "phone_delete_forbidden"
        );
      }
      try {
        phone = assertNormalizedPhone(String(u.phone));
      } catch (e) {
        throw new CaddyImportApplyError(
          e instanceof Error ? e.message : "유효하지 않은 휴대폰번호",
          400,
          "invalid_phone"
        );
      }
      const prev = phoneToOwner.get(phone);
      if (prev) {
        throw new CaddyImportApplyError(
          `파일/payload 내 중복 번호입니다.`,
          400,
          "duplicate_in_file"
        );
      }
      phoneToOwner.set(phone, `id:${u.id}`);
    }
    normalizedUpdates.push({ id: u.id, team: u.team, ...(phone ? { phone } : {}) });
  }

  for (const c of payload.creates) {
    let phone: string | undefined;
    if (c.phone !== undefined && c.phone !== null) {
      if (String(c.phone).trim() === "") {
        throw new CaddyImportApplyError(
          "import로는 휴대폰번호를 삭제할 수 없습니다.",
          400,
          "phone_delete_forbidden"
        );
      }
      try {
        phone = assertNormalizedPhone(String(c.phone));
      } catch (e) {
        throw new CaddyImportApplyError(
          e instanceof Error ? e.message : "유효하지 않은 휴대폰번호",
          400,
          "invalid_phone"
        );
      }
      const prev = phoneToOwner.get(phone);
      if (prev) {
        throw new CaddyImportApplyError(
          `파일/payload 내 중복 번호입니다.`,
          400,
          "duplicate_in_file"
        );
      }
      phoneToOwner.set(phone, `name:${c.name}`);
    }
    normalizedCreates.push({
      name: c.name,
      team: c.team,
      ...(phone ? { phone } : {}),
    });
  }

  // DB snapshot for guards (race-safe as of apply time)
  let existing =
    options?.existingForGuard ??
    (typeof prisma.caddy.findMany === "function"
      ? await prisma.caddy.findMany({
          select: { id: true, name: true, team: true, phoneNormalized: true },
        })
      : undefined);

  if (existing) {
    const ids = new Set(existing.map((e) => e.id));
    for (const u of normalizedUpdates) {
      if (!ids.has(u.id)) {
        throw new CaddyImportApplyError(
          `존재하지 않는 id는 갱신할 수 없습니다: ${u.id}`
        );
      }
    }

    const dbPhone = new Map<string, ExistingCaddy>();
    for (const e of existing) {
      if (e.phoneNormalized) dbPhone.set(e.phoneNormalized, e);
    }

    for (const u of normalizedUpdates) {
      if (!u.phone) continue;
      const holder = dbPhone.get(u.phone);
      if (holder && holder.id !== u.id) {
        throw new CaddyImportApplyError(
          "이미 등록된 휴대폰번호입니다.",
          409,
          "phone_duplicate"
        );
      }
    }
    for (const c of normalizedCreates) {
      if (!c.phone) continue;
      const holder = dbPhone.get(c.phone);
      if (holder) {
        throw new CaddyImportApplyError(
          "이미 등록된 휴대폰번호입니다.",
          409,
          "phone_duplicate"
        );
      }
    }
  }

  const run = async (client: PrismaLike) => {
    let updated = 0;
    let phoneUpdated = 0;
    const createdIds: number[] = [];

    for (const u of normalizedUpdates) {
      const data: { team: string; phoneNormalized?: string } = { team: u.team };
      if (u.phone) {
        data.phoneNormalized = u.phone;
        phoneUpdated++;
      }
      await client.caddy.update({
        where: { id: u.id },
        data,
      });
      updated++;
    }

    for (const c of normalizedCreates) {
      const data: { name: string; team: string; phoneNormalized?: string } = {
        name: c.name,
        team: c.team,
      };
      if (c.phone) data.phoneNormalized = c.phone;
      const row = await client.caddy.create({ data });
      createdIds.push(row.id);
    }

    return {
      updated,
      created: createdIds.length,
      skippedNeedsReview: 0,
      createdIds,
      phoneUpdated,
    } satisfies ApplyResult;
  };

  try {
    if (typeof prisma.$transaction === "function") {
      return await prisma.$transaction((tx) => run(tx));
    }
    return await run(prisma);
  } catch (e) {
    if (e instanceof CaddyImportApplyError) throw e;
    if (e instanceof CaddyPhoneError) {
      throw new CaddyImportApplyError(e.message, e.status, e.code);
    }
    if (isPhoneUniqueViolation(e)) {
      throw new CaddyImportApplyError(
        "이미 등록된 휴대폰번호입니다.",
        409,
        "phone_duplicate"
      );
    }
    throw e;
  }
}
