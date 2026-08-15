/**
 * 캐디 명단 Import v2 (CSV)
 *
 * 컬럼: id,name,team,teamOrder,employmentStatus,phone
 * - id optional — 있으면 Caddy.id 매칭 후 name 일치 검증
 * - id 없으면 exact name 1:1
 * - 기존 id update만 (삭제/재생성 금지)
 * - extraFlags 미반영
 * - missingInImport = 경고만 (자동 RETIRED 금지)
 * - ACTIVE+LEAVE 슬롯 점유 기준 teamOrder 중복 시 Apply 차단 (RETIRED 제외)
 * - 신규 create는 teamOrder 필수 (max+1 자동부여 없음)
 */

import {
  CaddyPhoneError,
  isPhoneUniqueViolation,
  maskKrMobile,
  normalizeKrMobile,
} from "./caddyPhone";
import {
  isNeedsReviewName,
  levenshtein,
  normalizePersonName,
  parseImportEmploymentStatus,
  parseImportTeamOrder,
  stripTrailingDigits,
  type EmploymentStatusValue,
} from "./caddyImportRules";
import { getConfiguredSlotCapacity } from "../src/lib/caddySlot";

const PHONE_HEADER_ALIASES = ["phone", "휴대폰", "전화번호", "mobile"] as const;

function isPhoneHeader(header: string): boolean {
  const trimmed = header.trim();
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();
  return PHONE_HEADER_ALIASES.some(
    (a) => a === trimmed || a.toLowerCase() === lower
  );
}

function headerKey(h: string): string {
  return h.trim().toLowerCase().replace(/\s+/g, "");
}

export type RosterExisting = {
  id: number;
  name: string;
  team: string;
  teamOrder: number;
  employmentStatus: string;
  phoneNormalized?: string | null;
};

export type RosterCsvRow = {
  rowNumber: number;
  id: number | null;
  name: string;
  team: string | null; // null = blank → keep (matched) / invalid for create
  teamOrder: number | null;
  employmentStatus: EmploymentStatusValue | null;
  phoneRaw: string | undefined; // undefined = column absent; "" = blank keep
  parseErrors: string[];
};

export type RosterAction =
  | "update"
  | "create"
  | "unchanged"
  | "needsReview"
  | "missingInImport";

export type RosterPreviewLine = {
  action: RosterAction;
  id: number | null;
  name: string;
  currentTeam: string | null;
  nextTeam: string | null;
  currentTeamOrder: number | null;
  nextTeamOrder: number | null;
  currentEmploymentStatus: string | null;
  nextEmploymentStatus: string | null;
  phoneChanged: boolean;
  currentMaskedPhone: string | null;
  nextMaskedPhone: string | null;
  reason?: string;
};

export type TeamOrderConflict = {
  team: string;
  teamOrder: number;
  names: string[];
  ids: Array<number | null>;
};

export type RosterApplyPayload = {
  updates: Array<{
    id: number;
    team?: string;
    teamOrder?: number;
    employmentStatus?: EmploymentStatusValue;
    phone?: string;
  }>;
  creates: Array<{
    name: string;
    team: string;
    teamOrder?: number;
    employmentStatus?: EmploymentStatusValue;
    phone?: string;
  }>;
};

export type RosterImportPreview = {
  format: "csv-v2";
  summary: {
    inputPeople: number;
    update: number;
    create: number;
    unchanged: number;
    needsReview: number;
    missingInImport: number;
    phoneIssues: number;
    teamOrderConflicts: number;
    applyBlocked: boolean;
    phoneColumnPresent: boolean;
  };
  lines: RosterPreviewLine[];
  needsReview: RosterPreviewLine[];
  missingInImport: RosterPreviewLine[];
  phoneIssues: Array<{
    kind: string;
    name: string;
    id: number | null;
    maskedPhone: string | null;
    message: string;
  }>;
  teamOrderConflicts: TeamOrderConflict[];
  applyPayload: RosterApplyPayload;
};

export type RosterApplyResult = {
  updated: number;
  created: number;
  phoneUpdated: number;
  createdIds: number[];
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

function findHeader(
  headers: string[],
  aliases: string[]
): number {
  const normalized = headers.map((h) => headerKey(h));
  for (const alias of aliases) {
    const idx = normalized.indexOf(headerKey(alias));
    if (idx !== -1) return idx;
  }
  return -1;
}

/**
 * CSV v2 파싱. name 필수. team/id/teamOrder/employmentStatus/phone optional columns.
 */
export function parseRosterCsvV2(text: string): RosterCsvRow[] {
  const cleaned = text.replace(/^\uFEFF/, "").trim();
  if (!cleaned) return [];
  const lines = cleaned.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];

  const headers = splitCsvLine(lines[0]);
  const nameIdx = findHeader(headers, ["name", "이름", "성명"]);
  if (nameIdx === -1) {
    throw new Error("CSV 헤더에 name(또는 이름/성명) 컬럼이 필요합니다.");
  }
  const idIdx = findHeader(headers, ["id"]);
  const teamIdx = findHeader(headers, ["team", "조"]);
  const orderIdx = findHeader(headers, ["teamorder", "teamOrder", "순번", "조내순번"]);
  const empIdx = findHeader(headers, [
    "employmentstatus",
    "employmentStatus",
    "재직상태",
    "상태",
  ]);
  const phoneIdx = headers.findIndex((h) => isPhoneHeader(h));
  const phoneColumnPresent = phoneIdx !== -1;

  const rows: RosterCsvRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = splitCsvLine(lines[i]);
    const name = normalizePersonName(
      unescapeCsvFormulaCell(parts[nameIdx] ?? "")
    );
    if (!name) continue;

    const parseErrors: string[] = [];
    let id: number | null = null;
    if (idIdx !== -1) {
      const rawId = (parts[idIdx] ?? "").trim();
      if (rawId) {
        if (!/^\d+$/.test(rawId)) {
          parseErrors.push(`id가 정수가 아닙니다: ${rawId}`);
        } else {
          id = Number(rawId);
        }
      }
    }

    let team: string | null = null;
    if (teamIdx !== -1) {
      const t = unescapeCsvFormulaCell(parts[teamIdx] ?? "")
        .trim()
        .replace(/\s+/g, "");
      team = t || null;
    }

    let teamOrder: number | null = null;
    if (orderIdx !== -1) {
      try {
        teamOrder = parseImportTeamOrder(parts[orderIdx] ?? "");
      } catch (e) {
        parseErrors.push(e instanceof Error ? e.message : String(e));
      }
    }

    let employmentStatus: EmploymentStatusValue | null = null;
    if (empIdx !== -1) {
      try {
        employmentStatus = parseImportEmploymentStatus(parts[empIdx] ?? "");
      } catch (e) {
        parseErrors.push(e instanceof Error ? e.message : String(e));
      }
    }

    let phoneRaw: string | undefined;
    if (phoneColumnPresent) {
      phoneRaw = (parts[phoneIdx] ?? "").trim();
    }

    rows.push({
      rowNumber: i,
      id,
      name,
      team,
      teamOrder,
      employmentStatus,
      phoneRaw,
      parseErrors,
    });
  }
  return rows;
}

function findNumberVariantCandidates(
  personName: string,
  existing: RosterExisting[]
): RosterExisting[] {
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
  pool: RosterExisting[]
): RosterExisting[] {
  const n = normalizePersonName(personName);
  return pool.filter((e) => {
    const en = normalizePersonName(e.name);
    if (en === n) return false;
    if (stripTrailingDigits(en) === stripTrailingDigits(n) && en !== n) {
      return false;
    }
    return levenshtein(n, en) === 1;
  });
}

type PhoneResolve = {
  intent: "absent" | "blank" | "set" | "invalid";
  normalized: string | null;
  masked: string | null;
  error?: string;
};

function resolvePhone(phoneRaw: string | undefined): PhoneResolve {
  if (phoneRaw === undefined) {
    return { intent: "absent", normalized: null, masked: null };
  }
  if (!phoneRaw.trim()) {
    return { intent: "blank", normalized: null, masked: null };
  }
  try {
    const normalized = normalizeKrMobile(phoneRaw);
    return {
      intent: "set",
      normalized,
      masked: maskKrMobile(normalized),
    };
  } catch (e) {
    return {
      intent: "invalid",
      normalized: null,
      masked: null,
      error:
        e instanceof CaddyPhoneError
          ? e.message
          : "유효한 휴대폰번호가 아닙니다.",
    };
  }
}

function empLabel(s: string | null | undefined): string | null {
  if (!s) return null;
  const u = String(s).toUpperCase();
  if (u === "ACTIVE" || s === "재직") return "ACTIVE";
  if (u === "LEAVE" || s === "휴직") return "LEAVE";
  if (u === "RETIRED" || s === "퇴사") return "RETIRED";
  return String(s);
}

/**
 * Preview (DB write 없음).
 */
export function buildRosterImportPreviewV2(
  rows: RosterCsvRow[],
  existing: RosterExisting[]
): RosterImportPreview {
  const byId = new Map(existing.map((e) => [e.id, e]));
  const byName = new Map<string, RosterExisting[]>();
  for (const e of existing) {
    const key = normalizePersonName(e.name);
    const list = byName.get(key) ?? [];
    list.push(e);
    byName.set(key, list);
  }

  const phoneColumnPresent = rows.some((r) => r.phoneRaw !== undefined);
  const phoneIssues: RosterImportPreview["phoneIssues"] = [];
  const lines: RosterPreviewLine[] = [];
  const matchedIds = new Set<number>();

  type Matched = {
    row: RosterCsvRow;
    cur: RosterExisting;
    nextTeam: string;
    nextOrder: number;
    nextEmp: string;
    phone: PhoneResolve;
    phoneChanged: boolean;
    applyPhone?: string;
    changed: boolean;
  };
  const matched: Matched[] = [];
  const createsDraft: Array<{
    row: RosterCsvRow;
    phone: PhoneResolve;
  }> = [];

  for (const row of rows) {
    const phone = resolvePhone(row.phoneRaw);

    if (row.parseErrors.length > 0) {
      lines.push({
        action: "needsReview",
        id: row.id,
        name: row.name,
        currentTeam: null,
        nextTeam: row.team,
        currentTeamOrder: null,
        nextTeamOrder: row.teamOrder,
        currentEmploymentStatus: null,
        nextEmploymentStatus: row.employmentStatus,
        phoneChanged: false,
        currentMaskedPhone: null,
        nextMaskedPhone: phone.masked,
        reason: row.parseErrors.join("; "),
      });
      continue;
    }

    if (isNeedsReviewName(row.name)) {
      const cands = [
        ...(byName.get(normalizePersonName(row.name)) ?? []),
        ...findNumberVariantCandidates(row.name, existing),
      ];
      lines.push({
        action: "needsReview",
        id: cands.length === 1 ? cands[0].id : row.id,
        name: row.name,
        currentTeam: cands[0]?.team ?? null,
        nextTeam: row.team,
        currentTeamOrder: cands[0]?.teamOrder ?? null,
        nextTeamOrder: row.teamOrder,
        currentEmploymentStatus: empLabel(cands[0]?.employmentStatus),
        nextEmploymentStatus: row.employmentStatus,
        phoneChanged: false,
        currentMaskedPhone: maskKrMobile(cands[0]?.phoneNormalized ?? null),
        nextMaskedPhone: phone.masked,
        reason: "동명이인/번호 표기 확인 필요 — 자동 적용 금지",
      });
      continue;
    }

    // --- id-first match ---
    if (row.id != null) {
      const cur = byId.get(row.id);
      if (!cur) {
        lines.push({
          action: "needsReview",
          id: row.id,
          name: row.name,
          currentTeam: null,
          nextTeam: row.team,
          currentTeamOrder: null,
          nextTeamOrder: row.teamOrder,
          currentEmploymentStatus: null,
          nextEmploymentStatus: row.employmentStatus,
          phoneChanged: false,
          currentMaskedPhone: null,
          nextMaskedPhone: phone.masked,
          reason: `id=${row.id} 가 DB에 없음 — 자동 적용 금지`,
        });
        continue;
      }
      if (normalizePersonName(cur.name) !== normalizePersonName(row.name)) {
        lines.push({
          action: "needsReview",
          id: cur.id,
          name: row.name,
          currentTeam: cur.team,
          nextTeam: row.team ?? cur.team,
          currentTeamOrder: cur.teamOrder,
          nextTeamOrder: row.teamOrder ?? cur.teamOrder,
          currentEmploymentStatus: empLabel(cur.employmentStatus),
          nextEmploymentStatus: row.employmentStatus ?? empLabel(cur.employmentStatus),
          phoneChanged: false,
          currentMaskedPhone: maskKrMobile(cur.phoneNormalized ?? null),
          nextMaskedPhone: phone.masked,
          reason: `id=${cur.id} 의 DB 이름("${cur.name}")과 CSV 이름("${row.name}") 불일치`,
        });
        continue;
      }
      if (matchedIds.has(cur.id)) {
        lines.push({
          action: "needsReview",
          id: cur.id,
          name: row.name,
          currentTeam: cur.team,
          nextTeam: row.team,
          currentTeamOrder: cur.teamOrder,
          nextTeamOrder: row.teamOrder,
          currentEmploymentStatus: empLabel(cur.employmentStatus),
          nextEmploymentStatus: row.employmentStatus,
          phoneChanged: false,
          currentMaskedPhone: maskKrMobile(cur.phoneNormalized ?? null),
          nextMaskedPhone: phone.masked,
          reason: `동일 id=${cur.id} 가 CSV에 중복 기재됨`,
        });
        continue;
      }
      matchedIds.add(cur.id);
      matched.push(buildMatched(row, cur, phone));
      continue;
    }

    // --- exact name 1:1 ---
    const candidates = byName.get(normalizePersonName(row.name)) ?? [];
    if (candidates.length > 1) {
      lines.push({
        action: "needsReview",
        id: null,
        name: row.name,
        currentTeam: null,
        nextTeam: row.team,
        currentTeamOrder: null,
        nextTeamOrder: row.teamOrder,
        currentEmploymentStatus: null,
        nextEmploymentStatus: row.employmentStatus,
        phoneChanged: false,
        currentMaskedPhone: null,
        nextMaskedPhone: phone.masked,
        reason: `동명이인 ${candidates.length}명(id: ${candidates
          .map((c) => c.id)
          .join(", ")}) — 자동 매칭 불가 (CSV에 id 명시 권장)`,
      });
      continue;
    }
    if (candidates.length === 1) {
      const cur = candidates[0];
      if (matchedIds.has(cur.id)) {
        lines.push({
          action: "needsReview",
          id: cur.id,
          name: row.name,
          currentTeam: cur.team,
          nextTeam: row.team,
          currentTeamOrder: cur.teamOrder,
          nextTeamOrder: row.teamOrder,
          currentEmploymentStatus: empLabel(cur.employmentStatus),
          nextEmploymentStatus: row.employmentStatus,
          phoneChanged: false,
          currentMaskedPhone: maskKrMobile(cur.phoneNormalized ?? null),
          nextMaskedPhone: phone.masked,
          reason: `이름 매칭 id=${cur.id} 가 이미 다른 행에서 매칭됨`,
        });
        continue;
      }
      matchedIds.add(cur.id);
      matched.push(buildMatched(row, cur, phone));
      continue;
    }

    // unmatched name — check typo / number variant before create
    const numCands = findNumberVariantCandidates(row.name, existing);
    if (numCands.length > 0) {
      lines.push({
        action: "needsReview",
        id: null,
        name: row.name,
        currentTeam: null,
        nextTeam: row.team,
        currentTeamOrder: null,
        nextTeamOrder: row.teamOrder,
        currentEmploymentStatus: null,
        nextEmploymentStatus: row.employmentStatus,
        phoneChanged: false,
        currentMaskedPhone: null,
        nextMaskedPhone: phone.masked,
        reason: `숫자 표기 변경 의심(후보 id: ${numCands
          .map((c) => c.id)
          .join(", ")}) — 자동 생성 금지`,
      });
      continue;
    }
    const unmatched = existing.filter((e) => !matchedIds.has(e.id));
    const typoCands = findTypoCandidates(row.name, unmatched);
    if (typoCands.length > 0) {
      lines.push({
        action: "needsReview",
        id: null,
        name: row.name,
        currentTeam: null,
        nextTeam: row.team,
        currentTeamOrder: null,
        nextTeamOrder: row.teamOrder,
        currentEmploymentStatus: null,
        nextEmploymentStatus: row.employmentStatus,
        phoneChanged: false,
        currentMaskedPhone: null,
        nextMaskedPhone: phone.masked,
        reason: `철자 유사 후보(id: ${typoCands
          .map((c) => c.id)
          .join(", ")}) — 자동 생성 금지`,
      });
      continue;
    }

    if (!row.team) {
      lines.push({
        action: "needsReview",
        id: null,
        name: row.name,
        currentTeam: null,
        nextTeam: null,
        currentTeamOrder: null,
        nextTeamOrder: row.teamOrder,
        currentEmploymentStatus: null,
        nextEmploymentStatus: row.employmentStatus,
        phoneChanged: false,
        currentMaskedPhone: null,
        nextMaskedPhone: phone.masked,
        reason: "신규 등록에 team이 필요합니다",
      });
      continue;
    }

    if (row.teamOrder == null || row.teamOrder < 1) {
      lines.push({
        action: "needsReview",
        id: null,
        name: row.name,
        currentTeam: null,
        nextTeam: row.team,
        currentTeamOrder: null,
        nextTeamOrder: row.teamOrder,
        currentEmploymentStatus: null,
        nextEmploymentStatus: row.employmentStatus,
        phoneChanged: false,
        currentMaskedPhone: null,
        nextMaskedPhone: phone.masked,
        reason: "신규 등록에 teamOrder(빈 슬롯)가 필요합니다",
      });
      continue;
    }

    const createCap = getConfiguredSlotCapacity(row.team);
    if (row.teamOrder > createCap) {
      lines.push({
        action: "needsReview",
        id: null,
        name: row.name,
        currentTeam: null,
        nextTeam: row.team,
        currentTeamOrder: null,
        nextTeamOrder: row.teamOrder,
        currentEmploymentStatus: null,
        nextEmploymentStatus: row.employmentStatus,
        phoneChanged: false,
        currentMaskedPhone: null,
        nextMaskedPhone: phone.masked,
        reason: `슬롯은 1~${createCap}만 선택 가능합니다 (요청: ${row.teamOrder})`,
      });
      continue;
    }

    createsDraft.push({ row, phone });
  }

  // phone validation for matched + creates
  const phoneOwners = new Map<string, { name: string; id: number | null }[]>();
  const blocked = new Set<string>();

  const considerPhone = (
    name: string,
    id: number | null,
    phone: PhoneResolve
  ) => {
    if (phone.intent === "invalid") {
      phoneIssues.push({
        kind: "invalid",
        name,
        id,
        maskedPhone: null,
        message: phone.error || "유효한 휴대폰번호가 아닙니다.",
      });
      blocked.add(normalizePersonName(name));
      return;
    }
    if (phone.intent === "set" && phone.normalized) {
      const list = phoneOwners.get(phone.normalized) ?? [];
      list.push({ name, id });
      phoneOwners.set(phone.normalized, list);
    }
  };

  for (const m of matched) considerPhone(m.row.name, m.cur.id, m.phone);
  for (const c of createsDraft) considerPhone(c.row.name, null, c.phone);

  for (const [phone, owners] of phoneOwners) {
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
      });
      blocked.add(normalizePersonName(owner.name));
    }
  }

  const dbPhone = new Map<string, RosterExisting>();
  for (const e of existing) {
    if (e.phoneNormalized) dbPhone.set(e.phoneNormalized, e);
  }
  for (const m of matched) {
    if (m.phone.intent !== "set" || !m.phone.normalized) continue;
    if (blocked.has(normalizePersonName(m.row.name))) continue;
    const holder = dbPhone.get(m.phone.normalized);
    if (holder && holder.id !== m.cur.id) {
      phoneIssues.push({
        kind: "duplicate_in_db",
        name: m.row.name,
        id: m.cur.id,
        maskedPhone: m.phone.masked,
        message: `다른 캐디(id=${holder.id}, ${holder.name})가 이미 사용 중`,
      });
      blocked.add(normalizePersonName(m.row.name));
    }
  }
  for (const c of createsDraft) {
    if (c.phone.intent !== "set" || !c.phone.normalized) continue;
    if (blocked.has(normalizePersonName(c.row.name))) continue;
    const holder = dbPhone.get(c.phone.normalized);
    if (holder) {
      phoneIssues.push({
        kind: "duplicate_in_db",
        name: c.row.name,
        id: null,
        maskedPhone: c.phone.masked,
        message: `다른 캐디(id=${holder.id}, ${holder.name})가 이미 사용 중`,
      });
      blocked.add(normalizePersonName(c.row.name));
    }
  }

  // materialize matched lines / creates / blocked → needsReview
  const applyUpdates: RosterApplyPayload["updates"] = [];
  const applyCreates: RosterApplyPayload["creates"] = [];
  let updateCount = 0;
  let unchangedCount = 0;
  let createCount = 0;

  for (const m of matched) {
    const key = normalizePersonName(m.row.name);
    if (blocked.has(key) || m.phone.intent === "invalid") {
      const issue = phoneIssues.find(
        (i) => normalizePersonName(i.name) === key
      );
      lines.push({
        action: "needsReview",
        id: m.cur.id,
        name: m.row.name,
        currentTeam: m.cur.team,
        nextTeam: m.nextTeam,
        currentTeamOrder: m.cur.teamOrder,
        nextTeamOrder: m.nextOrder,
        currentEmploymentStatus: empLabel(m.cur.employmentStatus),
        nextEmploymentStatus: m.nextEmp,
        phoneChanged: false,
        currentMaskedPhone: maskKrMobile(m.cur.phoneNormalized ?? null),
        nextMaskedPhone: m.phone.masked,
        reason: issue
          ? `휴대폰번호 문제(${issue.kind}) — 자동 적용 금지`
          : "휴대폰번호 문제 — 자동 적용 금지",
      });
      continue;
    }

    const nextCap = getConfiguredSlotCapacity(m.nextTeam);
    const orderChanging =
      m.nextOrder !== m.cur.teamOrder || m.nextTeam !== m.cur.team;
    if (
      orderChanging &&
      Number.isInteger(m.nextOrder) &&
      m.nextOrder > nextCap
    ) {
      lines.push({
        action: "needsReview",
        id: m.cur.id,
        name: m.row.name,
        currentTeam: m.cur.team,
        nextTeam: m.nextTeam,
        currentTeamOrder: m.cur.teamOrder,
        nextTeamOrder: m.nextOrder,
        currentEmploymentStatus: empLabel(m.cur.employmentStatus),
        nextEmploymentStatus: m.nextEmp,
        phoneChanged: false,
        currentMaskedPhone: maskKrMobile(m.cur.phoneNormalized ?? null),
        nextMaskedPhone: m.phone.masked,
        reason: `슬롯은 1~${nextCap}만 선택 가능합니다 (요청: ${m.nextOrder}) — 기존 capacity 초과 데이터는 임의 재번호하지 않습니다`,
      });
      continue;
    }

    const phoneChanged = Boolean(m.applyPhone);
    if (m.changed || phoneChanged) {
      updateCount++;
      const patch: RosterApplyPayload["updates"][number] = { id: m.cur.id };
      if (m.row.team != null && m.row.team !== "") patch.team = m.nextTeam;
      if (m.row.teamOrder != null) patch.teamOrder = m.nextOrder;
      if (m.row.employmentStatus != null) {
        patch.employmentStatus = m.row.employmentStatus;
      }
      if (m.applyPhone) patch.phone = m.applyPhone;
      // always send team if any roster field changes so apply has full team context for conflict? 
      // User said omit empty = keep. Only include provided fields.
      if (Object.keys(patch).length === 1) {
        // only id — treat as phone-only already handled; if nothing to apply skip
      }
      applyUpdates.push(patch);
      lines.push({
        action: "update",
        id: m.cur.id,
        name: m.row.name,
        currentTeam: m.cur.team,
        nextTeam: m.nextTeam,
        currentTeamOrder: m.cur.teamOrder,
        nextTeamOrder: m.nextOrder,
        currentEmploymentStatus: empLabel(m.cur.employmentStatus),
        nextEmploymentStatus: m.nextEmp,
        phoneChanged,
        currentMaskedPhone: maskKrMobile(m.cur.phoneNormalized ?? null),
        nextMaskedPhone: phoneChanged
          ? m.phone.masked
          : maskKrMobile(m.cur.phoneNormalized ?? null),
      });
    } else {
      unchangedCount++;
      lines.push({
        action: "unchanged",
        id: m.cur.id,
        name: m.row.name,
        currentTeam: m.cur.team,
        nextTeam: m.nextTeam,
        currentTeamOrder: m.cur.teamOrder,
        nextTeamOrder: m.nextOrder,
        currentEmploymentStatus: empLabel(m.cur.employmentStatus),
        nextEmploymentStatus: m.nextEmp,
        phoneChanged: false,
        currentMaskedPhone: maskKrMobile(m.cur.phoneNormalized ?? null),
        nextMaskedPhone: maskKrMobile(m.cur.phoneNormalized ?? null),
      });
    }
  }

  for (const c of createsDraft) {
    const key = normalizePersonName(c.row.name);
    if (blocked.has(key) || c.phone.intent === "invalid") {
      const issue = phoneIssues.find(
        (i) => normalizePersonName(i.name) === key
      );
      lines.push({
        action: "needsReview",
        id: null,
        name: c.row.name,
        currentTeam: null,
        nextTeam: c.row.team,
        currentTeamOrder: null,
        nextTeamOrder: c.row.teamOrder,
        currentEmploymentStatus: null,
        nextEmploymentStatus: c.row.employmentStatus,
        phoneChanged: false,
        currentMaskedPhone: null,
        nextMaskedPhone: c.phone.masked,
        reason: issue
          ? `휴대폰번호 문제(${issue.kind}) — 신규 생성 금지`
          : "휴대폰번호 문제 — 신규 생성 금지",
      });
      continue;
    }
    createCount++;
    const create: RosterApplyPayload["creates"][number] = {
      name: c.row.name,
      team: c.row.team!,
      teamOrder: c.row.teamOrder!,
    };
    if (c.row.employmentStatus != null) {
      create.employmentStatus = c.row.employmentStatus;
    }
    if (c.phone.intent === "set" && c.phone.normalized) {
      create.phone = c.phone.normalized;
    }
    applyCreates.push(create);
    lines.push({
      action: "create",
      id: null,
      name: c.row.name,
      currentTeam: null,
      nextTeam: c.row.team,
      currentTeamOrder: null,
      nextTeamOrder: c.row.teamOrder,
      currentEmploymentStatus: null,
      nextEmploymentStatus: c.row.employmentStatus ?? "ACTIVE",
      phoneChanged: c.phone.intent === "set",
      currentMaskedPhone: null,
      nextMaskedPhone: c.phone.masked,
    });
  }

  const missingInImport: RosterPreviewLine[] = existing
    .filter((e) => !matchedIds.has(e.id))
    .map((e) => ({
      action: "missingInImport" as const,
      id: e.id,
      name: e.name,
      currentTeam: e.team,
      nextTeam: null,
      currentTeamOrder: e.teamOrder,
      nextTeamOrder: null,
      currentEmploymentStatus: empLabel(e.employmentStatus),
      nextEmploymentStatus: null,
      phoneChanged: false,
      currentMaskedPhone: maskKrMobile(e.phoneNormalized ?? null),
      nextMaskedPhone: null,
      reason: "최신 명단에 없음 — 자동 퇴사/삭제 없음 (경고만)",
    }));

  lines.push(...missingInImport);

  // --- teamOrder conflict on final slot-holding (ACTIVE+LEAVE) state ---
  const finalById = new Map<
    number,
    { name: string; team: string; teamOrder: number; emp: string }
  >();
  for (const e of existing) {
    finalById.set(e.id, {
      name: e.name,
      team: e.team,
      teamOrder: e.teamOrder,
      emp: empLabel(e.employmentStatus) || "ACTIVE",
    });
  }
  for (const m of matched) {
    if (blocked.has(normalizePersonName(m.row.name))) continue;
    // skip needsReview matched that were blocked — already not in applyUpdates
    const inApply = applyUpdates.some((u) => u.id === m.cur.id);
    const unchanged = !m.changed && !m.applyPhone;
    if (!inApply && !unchanged) continue;
    finalById.set(m.cur.id, {
      name: m.row.name,
      team: m.nextTeam,
      teamOrder: m.nextOrder,
      emp: m.nextEmp,
    });
  }
  // creates as synthetic negative ids for conflict grouping
  const createFinals: Array<{
    name: string;
    team: string;
    teamOrder: number;
    emp: string;
    id: number | null;
  }> = [];
  for (const c of applyCreates) {
    createFinals.push({
      name: c.name,
      team: c.team,
      teamOrder: c.teamOrder ?? 0,
      emp: c.employmentStatus ?? "ACTIVE",
      id: null,
    });
  }

  const teamOrderConflicts = findTeamOrderConflicts([
    ...[...finalById.entries()].map(([id, v]) => ({
      id,
      name: v.name,
      team: v.team,
      teamOrder: v.teamOrder,
      emp: v.emp,
    })),
    ...createFinals,
  ]);

  const needsReviewLines = lines.filter((l) => l.action === "needsReview");
  const applyBlocked =
    needsReviewLines.length > 0 ||
    phoneIssues.length > 0 ||
    teamOrderConflicts.length > 0;

  const applyPayload: RosterApplyPayload = applyBlocked
    ? { updates: [], creates: [] }
    : { updates: applyUpdates, creates: applyCreates };

  // stable sort lines
  const order: Record<RosterAction, number> = {
    needsReview: 0,
    update: 1,
    create: 2,
    unchanged: 3,
    missingInImport: 4,
  };
  lines.sort(
    (a, b) =>
      order[a.action] - order[b.action] ||
      (a.id ?? 1e12) - (b.id ?? 1e12) ||
      a.name.localeCompare(b.name, "ko")
  );

  return {
    format: "csv-v2",
    summary: {
      inputPeople: rows.length,
      update: updateCount,
      create: createCount,
      unchanged: unchangedCount,
      needsReview: needsReviewLines.length,
      missingInImport: missingInImport.length,
      phoneIssues: phoneIssues.length,
      teamOrderConflicts: teamOrderConflicts.length,
      applyBlocked,
      phoneColumnPresent,
    },
    lines,
    needsReview: needsReviewLines,
    missingInImport,
    phoneIssues,
    teamOrderConflicts,
    applyPayload,
  };
}

function buildMatched(
  row: RosterCsvRow,
  cur: RosterExisting,
  phone: PhoneResolve
): {
  row: RosterCsvRow;
  cur: RosterExisting;
  nextTeam: string;
  nextOrder: number;
  nextEmp: string;
  phone: PhoneResolve;
  phoneChanged: boolean;
  applyPhone?: string;
  changed: boolean;
} {
  const nextTeam = row.team != null && row.team !== "" ? row.team : cur.team;
  const nextOrder = row.teamOrder != null ? row.teamOrder : cur.teamOrder;
  const nextEmp =
    row.employmentStatus != null
      ? row.employmentStatus
      : empLabel(cur.employmentStatus) || "ACTIVE";

  let applyPhone: string | undefined;
  let phoneChanged = false;
  const currentPhone = cur.phoneNormalized ?? null;
  if (
    phone.intent === "set" &&
    phone.normalized &&
    phone.normalized !== currentPhone
  ) {
    phoneChanged = true;
    applyPhone = phone.normalized;
  }

  const changed =
    nextTeam !== cur.team ||
    nextOrder !== cur.teamOrder ||
    nextEmp !== (empLabel(cur.employmentStatus) || "ACTIVE");

  return {
    row,
    cur,
    nextTeam,
    nextOrder,
    nextEmp,
    phone,
    phoneChanged,
    applyPhone,
    changed,
  };
}

function findTeamOrderConflicts(
  people: Array<{
    id: number | null;
    name: string;
    team: string;
    teamOrder: number;
    emp: string;
  }>
): TeamOrderConflict[] {
  // ACTIVE + LEAVE = 슬롯 보유. RETIRED는 빈자리로 취급.
  const holders = people.filter((p) => {
    const e = empLabel(p.emp);
    return e === "ACTIVE" || e === "LEAVE";
  });
  const groups = new Map<string, typeof holders>();
  for (const p of holders) {
    // teamOrder 0/missing: skip grouping (create without order → needsReview elsewhere)
    if (!p.teamOrder || p.teamOrder < 1) continue;
    const key = `${p.team}#${p.teamOrder}`;
    const list = groups.get(key) ?? [];
    list.push(p);
    groups.set(key, list);
  }
  const conflicts: TeamOrderConflict[] = [];
  for (const [, list] of groups) {
    if (list.length < 2) continue;
    conflicts.push({
      team: list[0].team,
      teamOrder: list[0].teamOrder,
      names: list.map((x) => x.name),
      ids: list.map((x) => x.id),
    });
  }
  return conflicts;
}

export class RosterImportApplyError extends Error {
  constructor(
    message: string,
    public status: number = 400,
    public code: string = "roster_import_apply_error"
  ) {
    super(message);
    this.name = "RosterImportApplyError";
  }
}

type PrismaLike = {
  caddy: {
    update: (args: {
      where: { id: number };
      data: Record<string, unknown>;
    }) => Promise<{ id: number }>;
    create: (args: {
      data: Record<string, unknown>;
    }) => Promise<{ id: number }>;
    findMany: (args?: {
      select?: Record<string, boolean>;
    }) => Promise<RosterExisting[]>;
    aggregate?: (args: {
      where: { team: string };
      _max: { teamOrder: true };
    }) => Promise<{ _max: { teamOrder: number | null } }>;
  };
  $transaction?: <T>(fn: (tx: PrismaLike) => Promise<T>) => Promise<T>;
};

/**
 * Apply — 서버에서 검증 재수행 후 all-or-nothing transaction.
 * 연관 Assignment/Schedule 등 수정 없음. Caddy 행만 update/create.
 */
export async function applyRosterImportPayloadV2(
  payload: RosterApplyPayload,
  prisma: PrismaLike,
  options?: { existingForGuard?: RosterExisting[] }
): Promise<RosterApplyResult> {
  for (const c of payload.creates) {
    if (!c.name?.trim() || !c.team?.trim()) {
      throw new RosterImportApplyError("create에 name, team 필수");
    }
    if (isNeedsReviewName(c.name)) {
      throw new RosterImportApplyError(
        `needsReview 이름은 신규 생성할 수 없습니다: ${c.name}`
      );
    }
    if (c.teamOrder == null || !Number.isInteger(c.teamOrder) || c.teamOrder < 1) {
      throw new RosterImportApplyError(
        `신규 등록에 teamOrder(슬롯)가 필요합니다: ${c.name}`,
        400,
        "slot_required"
      );
    }
    const createCap = getConfiguredSlotCapacity(c.team);
    if (c.teamOrder > createCap) {
      throw new RosterImportApplyError(
        `슬롯은 1~${createCap}만 선택 가능합니다: ${c.name} (요청: ${c.teamOrder})`,
        400,
        "slot_out_of_range"
      );
    }
  }
  for (const u of payload.updates) {
    if (!u.id) throw new RosterImportApplyError("update에 id 필수");
    if (u.teamOrder != null && (!Number.isInteger(u.teamOrder) || u.teamOrder < 1)) {
      throw new RosterImportApplyError(
        `teamOrder는 1 이상 정수여야 합니다: id=${u.id}`
      );
    }
    if (u.phone !== undefined && String(u.phone).trim() === "") {
      throw new RosterImportApplyError(
        "import로는 휴대폰번호를 삭제할 수 없습니다.",
        400,
        "phone_delete_forbidden"
      );
    }
  }

  const existing =
    options?.existingForGuard ??
    (await prisma.caddy.findMany({
      select: {
        id: true,
        name: true,
        team: true,
        teamOrder: true,
        employmentStatus: true,
        phoneNormalized: true,
      },
    }));

  const existingById = new Map(existing.map((e) => [e.id, e]));
  for (const u of payload.updates) {
    if (u.teamOrder == null) continue;
    const cur = existingById.get(u.id);
    if (!cur) {
      throw new RosterImportApplyError(`update 대상 없음: id=${u.id}`, 404);
    }
    const nextTeam = u.team ?? cur.team;
    const cap = getConfiguredSlotCapacity(nextTeam);
    const keepingOverCapacity =
      nextTeam === cur.team && u.teamOrder === cur.teamOrder && u.teamOrder > cap;
    if (u.teamOrder > cap && !keepingOverCapacity) {
      throw new RosterImportApplyError(
        `슬롯은 1~${cap}만 선택 가능합니다: id=${u.id} (요청: ${u.teamOrder})`,
        400,
        "slot_out_of_range"
      );
    }
  }

  // Re-run preview-equivalent conflict check from payload + existing
  const byId = new Map(existing.map((e) => [e.id, e]));
  for (const u of payload.updates) {
    if (!byId.has(u.id)) {
      throw new RosterImportApplyError(`존재하지 않는 id: ${u.id}`);
    }
  }

  // normalize phones + duplicate checks
  const phoneToOwner = new Map<string, string>();
  const normUpdates: Array<{
    id: number;
    team?: string;
    teamOrder?: number;
    employmentStatus?: EmploymentStatusValue;
    phone?: string;
  }> = [];
  const normCreates: typeof payload.creates = [];

  for (const u of payload.updates) {
    let phone: string | undefined;
    if (u.phone != null) {
      try {
        phone = normalizeKrMobile(String(u.phone));
      } catch (e) {
        throw new RosterImportApplyError(
          e instanceof Error ? e.message : "invalid phone",
          400,
          "invalid_phone"
        );
      }
      if (phoneToOwner.has(phone)) {
        throw new RosterImportApplyError("payload 내 중복 번호", 400, "duplicate_in_file");
      }
      phoneToOwner.set(phone, `id:${u.id}`);
    }
    normUpdates.push({ ...u, ...(phone ? { phone } : {}) });
  }
  for (const c of payload.creates) {
    let phone: string | undefined;
    if (c.phone != null) {
      try {
        phone = normalizeKrMobile(String(c.phone));
      } catch (e) {
        throw new RosterImportApplyError(
          e instanceof Error ? e.message : "invalid phone",
          400,
          "invalid_phone"
        );
      }
      if (phoneToOwner.has(phone)) {
        throw new RosterImportApplyError("payload 내 중복 번호", 400, "duplicate_in_file");
      }
      phoneToOwner.set(phone, `name:${c.name}`);
    }
    normCreates.push({ ...c, ...(phone ? { phone } : {}) });
  }

  const dbPhone = new Map<string, RosterExisting>();
  for (const e of existing) {
    if (e.phoneNormalized) dbPhone.set(e.phoneNormalized, e);
  }
  for (const u of normUpdates) {
    if (!u.phone) continue;
    const holder = dbPhone.get(u.phone);
    if (holder && holder.id !== u.id) {
      throw new RosterImportApplyError(
        "이미 등록된 휴대폰번호입니다.",
        409,
        "phone_duplicate"
      );
    }
  }
  for (const c of normCreates) {
    if (!c.phone) continue;
    if (dbPhone.get(c.phone)) {
      throw new RosterImportApplyError(
        "이미 등록된 휴대폰번호입니다.",
        409,
        "phone_duplicate"
      );
    }
  }

  // final ACTIVE teamOrder conflicts
  const finalState = new Map<
    number,
    { name: string; team: string; teamOrder: number; emp: string }
  >();
  for (const e of existing) {
    finalState.set(e.id, {
      name: e.name,
      team: e.team,
      teamOrder: e.teamOrder,
      emp: empLabel(e.employmentStatus) || "ACTIVE",
    });
  }
  for (const u of normUpdates) {
    const cur = finalState.get(u.id)!;
    finalState.set(u.id, {
      name: cur.name,
      team: u.team ?? cur.team,
      teamOrder: u.teamOrder ?? cur.teamOrder,
      emp: u.employmentStatus ?? cur.emp,
    });
  }
  const createStates = normCreates.map((c) => ({
    id: null as number | null,
    name: c.name,
    team: c.team,
    teamOrder: c.teamOrder ?? 0,
    emp: c.employmentStatus ?? "ACTIVE",
  }));
  const conflicts = findTeamOrderConflicts([
    ...[...finalState.entries()].map(([id, v]) => ({
      id,
      name: v.name,
      team: v.team,
      teamOrder: v.teamOrder,
      emp: v.emp,
    })),
    ...createStates,
  ]);
  if (conflicts.length > 0) {
    const c0 = conflicts[0];
    throw new RosterImportApplyError(
      `ACTIVE 조 내 teamOrder 충돌: ${c0.team} 순번 ${c0.teamOrder} (${c0.names.join(", ")})`,
      400,
      "team_order_conflict"
    );
  }

  const run = async (client: PrismaLike) => {
    let updated = 0;
    let phoneUpdated = 0;
    const createdIds: number[] = [];

    for (const u of normUpdates) {
      const data: Record<string, unknown> = {};
      if (u.team != null) data.team = u.team;
      if (u.teamOrder != null) data.teamOrder = u.teamOrder;
      if (u.employmentStatus != null) data.employmentStatus = u.employmentStatus;
      if (u.phone) {
        data.phoneNormalized = u.phone;
        phoneUpdated++;
      }
      if (Object.keys(data).length === 0) continue;
      await client.caddy.update({ where: { id: u.id }, data });
      updated++;
    }

    for (const c of normCreates) {
      const teamOrder = c.teamOrder;
      if (teamOrder == null || !Number.isInteger(teamOrder) || teamOrder < 1) {
        throw new RosterImportApplyError(
          `신규 등록에 teamOrder(슬롯)가 필요합니다: ${c.name}`,
          400,
          "slot_required"
        );
      }
      const data: Record<string, unknown> = {
        name: c.name,
        team: c.team,
        teamOrder,
        employmentStatus: c.employmentStatus ?? "ACTIVE",
      };
      if (c.phone) data.phoneNormalized = c.phone;
      const row = await client.caddy.create({ data });
      createdIds.push(row.id);
    }

    return {
      updated,
      created: createdIds.length,
      phoneUpdated,
      createdIds,
    } satisfies RosterApplyResult;
  };

  try {
    if (typeof prisma.$transaction === "function") {
      return await prisma.$transaction((tx) => run(tx));
    }
    return await run(prisma);
  } catch (e) {
    if (e instanceof RosterImportApplyError) throw e;
    if (e instanceof CaddyPhoneError) {
      throw new RosterImportApplyError(e.message, e.status, e.code);
    }
    if (isPhoneUniqueViolation(e)) {
      throw new RosterImportApplyError(
        "이미 등록된 휴대폰번호입니다.",
        409,
        "phone_duplicate"
      );
    }
    throw e;
  }
}

/** Excel formula injection 방어: = + - @ 선두면 앞에 ' 부여 */
export function escapeCsvFormulaCell(value: string): string {
  const v = String(value ?? "");
  if (/^[=+\-@]/.test(v)) return `'${v}`;
  return v;
}

/**
 * Export가 붙인 formula-escape 선두 ' 제거.
 * `'=...` / `'+...` / `'-...` / `'@...` 만 대상 — 일반 이름은 무변.
 */
export function unescapeCsvFormulaCell(value: string): string {
  const v = String(value ?? "");
  if (/^'[=+\-@]/.test(v)) return v.slice(1);
  return v;
}

/** Admin export CSV (full phone for round-trip). Caller must be admin-only. */
export function buildRosterExportCsv(rows: RosterExisting[]): string {
  const header = "id,name,team,teamOrder,employmentStatus,phone";
  const escape = (v: string) => {
    const formulaSafe = escapeCsvFormulaCell(v);
    if (/[",\n\r]/.test(formulaSafe)) {
      return `"${formulaSafe.replace(/"/g, '""')}"`;
    }
    return formulaSafe;
  };
  const lines = rows.map((r) => {
    const emp = empLabel(r.employmentStatus) || "ACTIVE";
    const phone = r.phoneNormalized ?? "";
    return [
      String(r.id),
      escape(r.name),
      escape(r.team),
      String(r.teamOrder ?? 0),
      emp,
      phone,
    ].join(",");
  });
  // UTF-8 BOM: Windows Excel 한글 호환. Import는 BOM strip.
  return "\uFEFF" + [header, ...lines].join("\n") + "\n";
}
