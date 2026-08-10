/**
 * 캐디 명단 import: parse → collapse → preview → (apply는 Preview 검증용 mock만)
 *
 * 명단 해석:
 * - 1~12조 = primaryTeam
 * - 주중반/주말반/드라이빙 = extras (별도 분류)
 * - exact 동일 이름은 한 사람으로 합침 (primary + extras 보존)
 * - 이름 뒤 숫자 1/2는 제거하지 않음 (서로 다른 사람)
 *
 * 매칭:
 * - Production exact name 1:1만 자동 매칭, 기존 ID 유지
 * - 철자 유사 / 숫자 표기 변경 = needsReview (자동 병합·생성 금지)
 * - missingInImport = 표시만 (자동 퇴사/삭제 없음)
 *
 * 스키마 호환 (migration 없음):
 * - Caddy.team = compatibleTeam(primaryTeam, extras)
 * - extras는 Preview/payload에만 포함. DB 컬럼 추가·쓰기는 하지 않음.
 */

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

export type ImportRow = {
  name: string;
  team: string;
  /** 원본 행 번호(1-based data row, 헤더 제외) — XLSX는 파서 seq */
  rowNumber: number;
  raw?: Record<string, string>;
};

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
};

export type ExistingCaddy = {
  id: number;
  name: string;
  team: string;
  status?: string | null;
  /** 향후 스키마 — 현재 Preview에서는 항상 []로 취급 */
  extras?: string[] | null;
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
};

export type PreviewUnchanged = {
  id: number;
  name: string;
  team: string;
  primaryTeam: string | null;
  extras: ExtraFlag[];
};

export type PreviewCreate = {
  name: string;
  team: string;
  primaryTeam: string | null;
  extras: ExtraFlag[];
  rowNumber: number;
};

export type PreviewNeedsReview = {
  name: string;
  team: string;
  primaryTeam: string | null;
  extras: ExtraFlag[];
  rowNumber: number;
  reason: string;
  candidateIds?: number[];
};

export type PreviewMissing = {
  id: number;
  name: string;
  team: string;
};

export type PreviewAction =
  | "update"
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
};

export type ApplyPayload = {
  /** team만 DB 반영 가능(현행 스키마). extras는 예약 필드(미저장). */
  updates: Array<{ id: number; team: string; extras: ExtraFlag[] }>;
  creates: Array<{ name: string; team: string; extras: ExtraFlag[] }>;
};

export type ImportPreview = {
  summary: {
    uniqueImportPeople: number;
    rawImportRows: number;
    mergedDuplicatePeople: number;
    update: number;
    unchanged: number;
    new: number;
    needsReview: number;
    missingInImport: number;
    /** create + exact-matched(update∪unchanged) 고유 인원 */
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
  unchanged: PreviewUnchanged[];
  creates: PreviewCreate[];
  needsReview: PreviewNeedsReview[];
  missingInImport: PreviewMissing[];
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
    rows.push({ name, team, rowNumber: i, raw });
  }
  return rows;
}

/**
 * CSV(team,name) 또는 XLSX/XLS(1~12조 가로 + 카트/성명) 파싱.
 * - 칸 단위 ImportRow 반환 (동일 이름 중복 칸 포함)
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

/**
 * exact name으로 칸을 고유 캐디로 합친다.
 * - 1~12조 → primaryTeam (복수 primary면 충돌 → 첫 값 유지, sourceTeams에 기록)
 * - 주중/주말/드라이빙 → extras
 * - 이름 뒤 숫자는 제거하지 않음
 */
export function collapseImportRowsToPeople(rows: ImportRow[]): ImportPerson[] {
  type Acc = {
    name: string;
    primaryTeam: string | null;
    extras: Set<string>;
    rowNumbers: number[];
    sourceTeams: string[];
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
      };
      byName.set(name, acc);
    }
    acc.rowNumbers.push(row.rowNumber);
    if (!acc.sourceTeams.includes(team)) acc.sourceTeams.push(team);

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

  const people: ImportPerson[] = [];
  for (const acc of byName.values()) {
    const extras = sortExtras(acc.extras);
    const team = compatibleTeamFrom(acc.primaryTeam, extras);
    people.push({
      name: acc.name,
      primaryTeam: acc.primaryTeam,
      extras,
      team,
      rowNumbers: acc.rowNumbers,
      sourceTeams: acc.sourceTeams,
      // 서로 다른 조/분류 칸에 기재된 경우만 "중복 병합"으로 표시
      mergedFromDuplicateCells: acc.sourceTeams.length > 1,
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
      reason: u.extrasOnly
        ? `extras 변경 예정: [${u.nextExtras.join(", ")}] (team 유지, DB extras 미적용)`
        : u.nextExtras.length
          ? `team ${u.currentTeam}→${u.nextTeam}, extras=[${u.nextExtras.join(", ")}]`
          : undefined,
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
      reason: "최신 명단에 없음 — 자동 퇴사/삭제 없음",
    });
  }

  const order: Record<PreviewAction, number> = {
    needsReview: 0,
    update: 1,
    create: 2,
    unchanged: 3,
    missingInImport: 4,
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

/**
 * 읽기 전용 preview. DB 쓰지 않음.
 */
export function buildImportPreview(
  importRows: ImportRow[],
  existing: ExistingCaddy[]
): ImportPreview {
  void shouldTouchEmploymentStatus();

  const people = collapseImportRowsToPeople(importRows);
  const byName = groupByName(existing);
  const matchedIds = new Set<number>();
  const reviewedImportNames = new Set<string>();

  const updates: PreviewUpdate[] = [];
  const unchanged: PreviewUnchanged[] = [];
  const creates: PreviewCreate[] = [];
  const needsReview: PreviewNeedsReview[] = [];

  // Pass 1: exact / explicit blocklist / prod duplicates
  const deferred: ImportPerson[] = [];

  for (const person of people) {
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

      if (!teamChanged && !extrasChanged) {
        unchanged.push({
          id: cur.id,
          name: cur.name,
          team: cur.team,
          primaryTeam: person.primaryTeam,
          extras: nextExtras,
        });
      } else {
        updates.push({
          id: cur.id,
          name: cur.name,
          currentTeam: cur.team,
          nextTeam: person.team,
          primaryTeam: person.primaryTeam,
          currentExtras: curExtras,
          nextExtras,
          extrasOnly: !teamChanged && extrasChanged,
        });
      }
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
      });
      reviewedImportNames.add(key);
      continue;
    }

    creates.push({
      name: person.name,
      team: person.team,
      primaryTeam: person.primaryTeam,
      extras: person.extras,
      rowNumber: person.rowNumbers[0] ?? 0,
    });
  }

  const missingInImport: PreviewMissing[] = existing
    .filter((c) => !matchedIds.has(c.id))
    .map((c) => ({ id: c.id, name: c.name, team: c.team }));

  const applyPayload: ApplyPayload = {
    updates: updates.map((u) => ({
      id: u.id,
      team: u.nextTeam,
      extras: u.nextExtras,
    })),
    creates: creates.map((c) => ({
      name: c.name,
      team: c.team,
      extras: c.extras,
    })),
  };

  const mergedDuplicates = people
    .filter((p) => p.mergedFromDuplicateCells && p.sourceTeams.length > 1)
    .map((p) => ({
      name: p.name,
      primaryTeam: p.primaryTeam,
      extras: p.extras,
      sourceTeams: p.sourceTeams,
    }));

  const countExtra = (flag: ExtraFlag) =>
    people.filter((p) => p.extras.includes(flag)).length;

  const extrasHeadcountFinal = {
    주중반: countExtra("주중반"),
    주말반: countExtra("주말반"),
    드라이빙: countExtra("드라이빙"),
  };

  const matchedCount = updates.length + unchanged.length;
  const createPlusMatched = creates.length + matchedCount;
  const partitionCount = createPlusMatched + needsReview.length;
  const uniqueImportPeople = people.length;

  // expected total = existing - none deleted + creates (needsReview not created)
  const expectedTotalAfterApply = existing.length + creates.length;

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
      createPlusMatched,
      partitionMatchesUnique: partitionCount === uniqueImportPeople,
      createPlusMatchedEqualsUnique: createPlusMatched === uniqueImportPeople,
      expectedTotalAfterApply,
      extrasHeadcount: extrasHeadcountFinal,
    },
    people,
    mergedDuplicates,
    updates,
    unchanged,
    creates,
    needsReview,
    missingInImport,
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
      note:
        "Preview만 수행. team=primary 또는 extra-only 분류. extras는 payload에만 포함하며 DB에 쓰지 않음.",
    },
  };
}

type PrismaLike = {
  caddy: {
    update: (args: {
      where: { id: number };
      data: { team: string };
    }) => Promise<{ id: number; name: string; team: string }>;
    create: (args: {
      data: { name: string; team: string };
    }) => Promise<{ id: number; name: string; team: string }>;
  };
  $transaction?: <T>(fn: (tx: PrismaLike) => Promise<T>) => Promise<T>;
};

/**
 * apply: ID 유지 update + 신규 create만.
 * - extras 필드는 현행 스키마에 없으므로 저장하지 않음 (team만)
 * - needsReview 이름 create 거부
 * - 삭제/재생성/employmentStatus 변경 없음
 *
 * 주의: Production에 실행하지 말 것. Preview 검증·로컬 mock용.
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
      throw new Error(`needsReview 이름은 신규 생성할 수 없습니다: ${c.name}`);
    }
  }

  if (options?.existingForGuard) {
    const ids = new Set(options.existingForGuard.map((e) => e.id));
    for (const u of payload.updates) {
      if (!ids.has(u.id)) {
        throw new Error(`존재하지 않는 id는 갱신할 수 없습니다: ${u.id}`);
      }
    }
  }

  const run = async (client: PrismaLike) => {
    let updated = 0;
    const createdIds: number[] = [];

    for (const u of payload.updates) {
      // id 유지, team만 변경 — extras/employmentStatus 미포함
      await client.caddy.update({
        where: { id: u.id },
        data: { team: u.team },
      });
      updated++;
    }

    for (const c of payload.creates) {
      const row = await client.caddy.create({
        data: { name: c.name, team: c.team },
      });
      createdIds.push(row.id);
    }

    return {
      updated,
      created: createdIds.length,
      skippedNeedsReview: 0,
      createdIds,
    } satisfies ApplyResult;
  };

  if (typeof prisma.$transaction === "function") {
    return prisma.$transaction((tx) => run(tx));
  }
  return run(prisma);
}
