/**
 * 캐디 명단 import: parse → preview → apply
 *
 * 규칙:
 * - 기존 인원 ID 절대 재생성/변경 금지
 * - 이름 exact match로만 자동 매칭, 조가 다르면 team만 갱신
 * - 신규만 create
 * - NEEDS_REVIEW_NAMES는 자동 매칭·신규 생성 금지
 * - employmentStatus/퇴사 처리 변경 금지
 * - 주중반/주말반 caddyType(THIRD) DB 반영 없음
 */

import {
  isNeedsReviewName,
  normalizePersonName,
  shouldTouchEmploymentStatus,
} from "./caddyImportRules";
import { parseXlsxRosterBuffer } from "./caddyImportXlsx";

export type ImportRow = {
  name: string;
  team: string;
  /** 원본 행 번호(1-based data row, 헤더 제외) */
  rowNumber: number;
  raw?: Record<string, string>;
};

export type ExistingCaddy = {
  id: number;
  name: string;
  team: string;
  status?: string | null;
};

export type PreviewUpdate = {
  id: number;
  name: string;
  currentTeam: string;
  nextTeam: string;
};

export type PreviewUnchanged = {
  id: number;
  name: string;
  team: string;
};

export type PreviewCreate = {
  name: string;
  team: string;
  rowNumber: number;
};

export type PreviewNeedsReview = {
  name: string;
  team: string;
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

/** Preview 테이블용 평탄 행 */
export type PreviewLine = {
  action: PreviewAction;
  id: number | null;
  name: string;
  currentTeam: string | null;
  nextTeam: string | null;
  reason?: string;
};

export type ApplyPayload = {
  updates: Array<{ id: number; team: string }>;
  creates: Array<{ name: string; team: string }>;
};

export type ImportPreview = {
  summary: {
    update: number;
    unchanged: number;
    new: number;
    needsReview: number;
    missingInImport: number;
  };
  updates: PreviewUpdate[];
  unchanged: PreviewUnchanged[];
  creates: PreviewCreate[];
  needsReview: PreviewNeedsReview[];
  missingInImport: PreviewMissing[];
  /** UI 표시용: id / 이름 / 기존 조 / 최신 조 / 처리 결과 */
  lines: PreviewLine[];
  applyPayload: ApplyPayload;
  /** 항상 false — employmentStatus 변경 없음 */
  touchesEmploymentStatus: false;
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
 * - 카트번호·고정카트 색·주중반/주말반·휴무 등은 DB에 반영하지 않음
 * - id 컬럼이 있어도 매칭에 사용하지 않음(이름 기준)
 */
export function parseImportFile(buffer: Buffer | string, filename = "import.csv"): ImportRow[] {
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

export function buildPreviewLines(preview: Omit<ImportPreview, "lines">): PreviewLine[] {
  const lines: PreviewLine[] = [];

  for (const u of preview.updates) {
    lines.push({
      action: "update",
      id: u.id,
      name: u.name,
      currentTeam: u.currentTeam,
      nextTeam: u.nextTeam,
    });
  }
  for (const u of preview.unchanged) {
    lines.push({
      action: "unchanged",
      id: u.id,
      name: u.name,
      currentTeam: u.team,
      nextTeam: u.team,
    });
  }
  for (const c of preview.creates) {
    lines.push({
      action: "create",
      id: null,
      name: c.name,
      currentTeam: null,
      nextTeam: c.team,
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
      reason:
        ids.length > 1
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

/**
 * 읽기 전용 preview. DB 쓰지 않음.
 * - 이름 exact match(공백 제거) 1:1만 자동 매칭
 * - 동명이인 / 확인 대상 이름은 needsReview
 * - missingInImport는 표시만 (자동 퇴사·삭제 없음)
 * - employmentStatus 변경 계획 없음
 */
export function buildImportPreview(
  importRows: ImportRow[],
  existing: ExistingCaddy[]
): ImportPreview {
  void shouldTouchEmploymentStatus();

  const byName = groupByName(existing);
  const matchedIds = new Set<number>();

  const updates: PreviewUpdate[] = [];
  const unchanged: PreviewUnchanged[] = [];
  const creates: PreviewCreate[] = [];
  const needsReview: PreviewNeedsReview[] = [];

  for (const row of importRows) {
    const key = normalizePersonName(row.name);

    if (isNeedsReviewName(row.name)) {
      const candidates = byName.get(key) ?? [];
      needsReview.push({
        name: row.name,
        team: row.team,
        rowNumber: row.rowNumber,
        reason: "동명이인/번호 표기 확인 필요 — 자동 매칭·신규 생성 금지",
        candidateIds: candidates.map((c) => c.id),
      });
      // 확인 대상은 기존 ID도 matched로 잡지 않음(누락 목록에 남을 수 있음 → 수동 확인)
      continue;
    }

    const candidates = byName.get(key) ?? [];

    if (candidates.length > 1) {
      needsReview.push({
        name: row.name,
        team: row.team,
        rowNumber: row.rowNumber,
        reason: `동명이인 ${candidates.length}명 — 자동 매칭 불가`,
        candidateIds: candidates.map((c) => c.id),
      });
      continue;
    }

    if (candidates.length === 1) {
      const cur = candidates[0];
      matchedIds.add(cur.id);
      if (cur.team !== row.team) {
        updates.push({
          id: cur.id,
          name: cur.name,
          currentTeam: cur.team,
          nextTeam: row.team,
        });
      } else {
        unchanged.push({ id: cur.id, name: cur.name, team: cur.team });
      }
      continue;
    }

    // 미매칭 → 신규
    creates.push({ name: row.name, team: row.team, rowNumber: row.rowNumber });
  }

  const missingInImport: PreviewMissing[] = existing
    .filter((c) => !matchedIds.has(c.id))
    .map((c) => ({ id: c.id, name: c.name, team: c.team }));

  const applyPayload: ApplyPayload = {
    updates: updates.map((u) => ({ id: u.id, team: u.nextTeam })),
    creates: creates.map((c) => ({ name: c.name, team: c.team })),
  };

  const base = {
    summary: {
      update: updates.length,
      unchanged: unchanged.length,
      new: creates.length,
      needsReview: needsReview.length,
      missingInImport: missingInImport.length,
    },
    updates,
    unchanged,
    creates,
    needsReview,
    missingInImport,
    applyPayload,
    touchesEmploymentStatus: false as const,
  };

  return {
    ...base,
    lines: buildPreviewLines(base),
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
 * - needsReview는 payload에 포함되지 않아야 함(포함 시 거부)
 * - employmentStatus 필드 절대 쓰지 않음
 * - 삭제/재생성 없음
 */
export async function applyImportPayload(
  payload: ApplyPayload,
  prisma: PrismaLike,
  options?: { rejectNeedsReviewNames?: boolean; existingForGuard?: ExistingCaddy[] }
): Promise<ApplyResult> {
  void shouldTouchEmploymentStatus();

  const reject = options?.rejectNeedsReviewNames !== false;

  for (const c of payload.creates) {
    if (reject && isNeedsReviewName(c.name)) {
      throw new Error(`needsReview 이름은 신규 생성할 수 없습니다: ${c.name}`);
    }
  }

  // update id가 실제 존재하는지(옵션)
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
      // id 유지, team만 변경 — employmentStatus/status 미포함
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
