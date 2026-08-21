/**
 * XLSX v1 안전 반영.
 * 매칭은 기존 v1 Preview, DB write는 기존 v2 Apply 엔진.
 * 파일 순서/rowNumber/카트 → teamOrder 변환 없음.
 */
import {
  buildImportPreview,
  type ImportRow,
} from "./caddyImport";
import {
  isExtraFlag,
  isNumericOnlyRosterName,
  isPrimaryTeam,
  normalizePersonName,
} from "./caddyImportRules";
import {
  applyRosterImportPayloadV2,
  ROSTER_IMPORT_APPLY_TX_OPTIONS,
  type RosterApplyPayload,
  type RosterExisting,
} from "./caddyRosterImportV2";
import { occupiesHouseThirdSlot } from "../src/lib/caddyManage";
import {
  listV1ProjectedEmptySlots,
  mergeV1SafeResolutions,
  v1DuplicateSlotChoices,
  v1SafeApplyReady,
  type V1SafeCandidate,
  type V1SafeDecisionRow,
  type V1SafeImportPerson,
  type V1SafeResolution,
} from "../src/lib/caddyRosterImportV1SafeShared";
import type { SlotOccupant } from "../src/lib/caddySlot";

export class XlsxV1SafeApplyError extends Error {
  constructor(
    message: string,
    public status: number = 400,
    public code: string = "xlsx_v1_safe_blocked"
  ) {
    super(message);
    this.name = "XlsxV1SafeApplyError";
  }
}

export type XlsxV1SafePreview = {
  format: "xlsx-v1";
  summary: {
    uniqueImportPeople: number;
    autoKeep: number;
    move: number;
    create: number;
    needsReview: number;
    missingInImport: number;
    extraOnly: number;
    applyReady: boolean;
    applyBlockedReasons: string[];
  };
  rows: V1SafeDecisionRow[];
  extraOnly: Array<{ name: string; team: string }>;
  importPeople: V1SafeImportPerson[];
  occupants: SlotOccupant[];
  missing: Array<{
    id: number;
    name: string;
    team: string;
    teamOrder: number;
    employmentStatus: string;
  }>;
};

function compactTeam(team: string): string {
  return team.trim().replace(/\s+/g, "");
}

function isHoldingEmp(emp: string | null | undefined): boolean {
  const u = String(emp ?? "").toUpperCase();
  return u === "ACTIVE" || u === "LEAVE" || emp === "재직" || emp === "휴직";
}

function occupantOf(e: RosterExisting): SlotOccupant {
  return {
    id: e.id,
    name: e.name,
    team: e.team,
    teamOrder: e.teamOrder,
    employmentStatus: String(e.employmentStatus),
    caddyType: e.caddyType ?? null,
  };
}

function isV2MissingCandidate(e: RosterExisting): boolean {
  return occupiesHouseThirdSlot(e) && isHoldingEmp(e.employmentStatus);
}

function candidateOf(e: RosterExisting): V1SafeCandidate {
  return {
    id: e.id,
    name: e.name,
    team: e.team,
    teamOrder: e.teamOrder,
    employmentStatus: String(e.employmentStatus),
  };
}

export function buildXlsxV1SafePreview(
  importRows: ImportRow[],
  existing: RosterExisting[]
): XlsxV1SafePreview {
  const extraOnlyRows = importRows.filter((r) => isExtraFlag(compactTeam(r.team)));
  const primaryRows = importRows.filter((r) =>
    isPrimaryTeam(compactTeam(r.team))
  );
  const extraOnlyNames = new Set(
    extraOnlyRows
      .map((r) => normalizePersonName(r.name))
      .filter((n) => n && !primaryRows.some((p) => normalizePersonName(p.name) === n))
  );
  const extraOnly = extraOnlyRows
    .filter((r) => extraOnlyNames.has(normalizePersonName(r.name)))
    .reduce<Array<{ name: string; team: string }>>((acc, r) => {
      const name = normalizePersonName(r.name);
      if (!acc.some((x) => x.name === name)) {
        acc.push({ name, team: compactTeam(r.team) });
      }
      return acc;
    }, []);

  const preview = buildImportPreview(
    primaryRows,
    existing.map((e) => ({
      id: e.id,
      name: e.name,
      team: e.team,
      phoneNormalized: e.phoneNormalized,
    }))
  );

  const byId = new Map(existing.map((e) => [e.id, e]));
  const rows: V1SafeDecisionRow[] = [];
  const matchedIds = new Set<number>();

  const pushKeep = (id: number, name: string, team: string) => {
    const cur = byId.get(id);
    matchedIds.add(id);
    rows.push({
      key: name,
      kind: "keep",
      name,
      fileTeam: team,
      currentId: id,
      currentTeam: cur?.team ?? team,
      currentTeamOrder: cur?.teamOrder ?? null,
      candidates: [],
    });
  };

  for (const u of preview.unchanged) {
    pushKeep(u.id, u.name, u.team);
  }
  for (const u of preview.phoneOnlyUpdates) {
    pushKeep(u.id, u.name, u.team);
  }
  for (const u of preview.updates) {
    if (u.currentTeam === u.nextTeam) {
      pushKeep(u.id, u.name, u.nextTeam);
      continue;
    }
    const cur = byId.get(u.id);
    matchedIds.add(u.id);
    rows.push({
      key: u.name,
      kind: "move",
      name: u.name,
      fileTeam: u.nextTeam,
      currentId: u.id,
      currentTeam: u.currentTeam,
      currentTeamOrder: cur?.teamOrder ?? null,
      reason: `${u.currentTeam} → ${u.nextTeam}`,
      candidates: [],
    });
  }
  for (const c of preview.creates) {
    if (!c.team || !isPrimaryTeam(compactTeam(c.team))) continue;
    if (isNumericOnlyRosterName(c.name)) {
      rows.push({
        key: `invalid:${c.name}:${compactTeam(c.team)}`,
        kind: "invalid",
        name: c.name,
        fileTeam: compactTeam(c.team),
        currentId: null,
        currentTeam: null,
        currentTeamOrder: null,
        reason: "성명이 아니라 숫자입니다 (카트/행번호). 신규 등록 불가",
        candidates: [],
      });
      continue;
    }
    rows.push({
      key: c.name,
      kind: "create",
      name: c.name,
      fileTeam: compactTeam(c.team),
      currentId: null,
      currentTeam: null,
      currentTeamOrder: null,
      candidates: [],
    });
  }
  for (const n of preview.needsReview) {
    const fileTeam = n.primaryTeam || (n.team && isPrimaryTeam(compactTeam(n.team))
      ? compactTeam(n.team)
      : null);
    if (!fileTeam) continue;
    const candidates = (n.candidateIds ?? [])
      .map((id) => byId.get(id))
      .filter((e): e is RosterExisting => !!e)
      .map(candidateOf);
    rows.push({
      key: n.name,
      kind: "needsReview",
      name: n.name,
      fileTeam,
      currentId: null,
      currentTeam: null,
      currentTeamOrder: null,
      reason: n.reason,
      candidates,
    });
  }

  const reviewCandidateIds = new Set(
    rows.flatMap((r) => r.candidates.map((c) => c.id))
  );
  const missing = existing
    .filter(
      (e) =>
        isV2MissingCandidate(e) &&
        !matchedIds.has(e.id) &&
        !reviewCandidateIds.has(e.id)
    )
    .map((e) => ({
      id: e.id,
      name: e.name,
      team: e.team,
      teamOrder: e.teamOrder,
      employmentStatus: String(e.employmentStatus),
    }));
  for (const m of missing) {
    rows.push({
      key: `missing:${m.id}`,
      kind: "missing",
      name: m.name,
      fileTeam: null,
      currentId: m.id,
      currentTeam: m.team,
      currentTeamOrder: m.teamOrder,
      reason: "이번 1~12조 명단에 없음 — 자동 퇴사/삭제 없음",
      candidates: [],
    });
  }
  for (const e of extraOnly) {
    rows.push({
      key: `extra:${e.name}`,
      kind: "extraOnly",
      name: e.name,
      fileTeam: e.team,
      currentId: null,
      currentTeam: null,
      currentTeamOrder: null,
      reason: "주중반/주말반/드라이빙 only — 일반 1~12조 Apply 대상 아님",
      candidates: [],
    });
  }

  const importPeople: V1SafeImportPerson[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (
      (r.kind === "keep" ||
        r.kind === "move" ||
        r.kind === "create" ||
        r.kind === "needsReview") &&
      r.fileTeam &&
      !seen.has(r.name)
    ) {
      seen.add(r.name);
      importPeople.push({ name: r.name, team: r.fileTeam });
    }
  }

  const ready = v1SafeApplyReady(rows);
  return {
    format: "xlsx-v1",
    summary: {
      uniqueImportPeople: importPeople.length,
      autoKeep: ready.autoKeep,
      move: ready.move,
      create: ready.create,
      needsReview: ready.needsReview,
      missingInImport: missing.length,
      extraOnly: extraOnly.length,
      applyReady: ready.ready,
      applyBlockedReasons: ready.reasons,
    },
    rows,
    extraOnly,
    importPeople,
    occupants: existing.map(occupantOf),
    missing,
  };
}

function assertSlotFree(
  occupants: SlotOccupant[],
  rows: ReturnType<typeof mergeV1SafeResolutions>,
  name: string,
  team: string,
  teamOrder: number
) {
  const empty = listV1ProjectedEmptySlots(occupants, rows, team, name);
  if (!empty.includes(teamOrder)) {
    throw new XlsxV1SafeApplyError(
      `${name}: ${team} ${teamOrder}번은 최종 예상 상태에서 빈 슬롯이 아닙니다.`
    );
  }
}

export async function applyXlsxV1SafePayload(
  input: {
    importPeople: V1SafeImportPerson[];
    resolutions?: V1SafeResolution[];
  },
  prisma: Parameters<typeof applyRosterImportPayloadV2>[1],
  options?: { existingForGuard?: RosterExisting[] }
) {
  if (!Array.isArray(input?.importPeople)) {
    throw new XlsxV1SafeApplyError("importPeople 배열이 필요합니다.");
  }
  for (const p of input.importPeople) {
    if (!p?.name || !p?.team || !isPrimaryTeam(compactTeam(p.team))) {
      throw new XlsxV1SafeApplyError(
        "importPeople는 1~12조 name/team 만 허용합니다."
      );
    }
    if (isNumericOnlyRosterName(p.name)) {
      throw new XlsxV1SafeApplyError(
        `숫자만 있는 이름은 신규 등록할 수 없습니다: ${p.name}`
      );
    }
  }

  const loadExisting = async (client: typeof prisma) =>
    options?.existingForGuard ??
    (await client.caddy.findMany({
      select: {
        id: true,
        name: true,
        team: true,
        teamOrder: true,
        employmentStatus: true,
        phoneNormalized: true,
        thirdBandSubgroup: true,
        caddyType: true,
      },
    }));

  const run = async (client: typeof prisma) => {
    const existing = await loadExisting(client);
    return applyXlsxV1SafeAgainstExisting(input, client, existing);
  };

  if (options?.existingForGuard) {
    return run(prisma);
  }
  if (typeof prisma.$transaction === "function") {
    return prisma.$transaction((tx) => run(tx), ROSTER_IMPORT_APPLY_TX_OPTIONS);
  }
  return run(prisma);
}

async function applyXlsxV1SafeAgainstExisting(
  input: {
    importPeople: V1SafeImportPerson[];
    resolutions?: V1SafeResolution[];
  },
  prisma: Parameters<typeof applyRosterImportPayloadV2>[1],
  existing: RosterExisting[]
) {
  const importRows: ImportRow[] = input.importPeople.map((p, i) => ({
    name: p.name,
    team: compactTeam(p.team),
    rowNumber: i + 1,
  }));
  const preview = buildXlsxV1SafePreview(importRows, existing);
  const resByName = new Map(
    (input.resolutions ?? []).map((r) => [normalizePersonName(r.name), r])
  );
  const resRecord: Record<string, V1SafeResolution> = {};
  for (const [k, v] of resByName) resRecord[k] = v;
  const merged = mergeV1SafeResolutions(preview.rows, resRecord);

  for (const row of merged) {
    if (row.kind === "keep" || row.kind === "missing" || row.kind === "extraOnly" || row.kind === "invalid") {
      continue;
    }
    const res = resByName.get(normalizePersonName(row.name));
    if (row.kind === "move") {
      if (res?.matchId != null && res.matchId !== row.currentId) {
        throw new XlsxV1SafeApplyError(
          `${row.name}: 조 이동 대상 id를 바꿀 수 없습니다.`
        );
      }
      if (res?.teamOrder == null || !Number.isInteger(res.teamOrder) || res.teamOrder < 1) {
        throw new XlsxV1SafeApplyError(`${row.name}: 조 이동 순번이 필요합니다.`);
      }
      row.teamOrder = res.teamOrder;
      continue;
    }
    if (row.kind === "create") {
      if (isNumericOnlyRosterName(row.name)) {
        throw new XlsxV1SafeApplyError(
          `숫자만 있는 이름은 신규 등록할 수 없습니다: ${row.name}`
        );
      }
      if (res?.matchId != null) {
        throw new XlsxV1SafeApplyError(
          `${row.name}: 신규 행에 기존 id를 지정할 수 없습니다.`
        );
      }
      if (res?.teamOrder == null || !Number.isInteger(res.teamOrder) || res.teamOrder < 1) {
        throw new XlsxV1SafeApplyError(`${row.name}: 신규 순번이 필요합니다.`);
      }
      row.asCreate = true;
      row.teamOrder = res.teamOrder;
      continue;
    }
    if (row.kind === "needsReview") {
      if (!res || (!res.asCreate && res.matchId == null)) {
        throw new XlsxV1SafeApplyError(`${row.name}: 검토필요 미해결`);
      }
      if (res.asCreate && res.matchId != null) {
        throw new XlsxV1SafeApplyError(
          `${row.name}: 기존 캐디와 신규를 동시에 선택할 수 없습니다.`
        );
      }
      if (res.asCreate) {
        if (isNumericOnlyRosterName(row.name)) {
          throw new XlsxV1SafeApplyError(
            `숫자만 있는 이름은 신규 등록할 수 없습니다: ${row.name}`
          );
        }
        if (res.teamOrder == null || !Number.isInteger(res.teamOrder) || res.teamOrder < 1) {
          throw new XlsxV1SafeApplyError(`${row.name}: 신규 순번이 필요합니다.`);
        }
        row.asCreate = true;
        row.teamOrder = res.teamOrder;
        continue;
      }
      const allowed = new Set(row.candidates.map((c) => c.id));
      if (res.matchId == null || !allowed.has(res.matchId)) {
        throw new XlsxV1SafeApplyError(
          `${row.name}: 매칭 후보에 없는 id 입니다.`
        );
      }
      const cand = row.candidates.find((c) => c.id === res.matchId)!;
      row.matchId = res.matchId;
      if (row.fileTeam && cand.team !== row.fileTeam) {
        if (res.teamOrder == null || !Number.isInteger(res.teamOrder) || res.teamOrder < 1) {
          throw new XlsxV1SafeApplyError(`${row.name}: 조 이동 순번이 필요합니다.`);
        }
        row.teamOrder = res.teamOrder;
      } else {
        row.teamOrder = null;
      }
    }
  }

  const ready = v1SafeApplyReady(merged);
  if (!ready.ready) {
    throw new XlsxV1SafeApplyError(
      ready.reasons[0] || "관리자 확인이 끝나지 않았습니다."
    );
  }
  const dups = v1DuplicateSlotChoices(merged);
  if (dups.length) {
    throw new XlsxV1SafeApplyError(
      `${dups[0].team} ${dups[0].teamOrder}번 중복 선택`
    );
  }

  const occupants = existing.map(occupantOf);
  const updates: RosterApplyPayload["updates"] = [];
  const creates: RosterApplyPayload["creates"] = [];
  const matchedExistingIds: number[] = [];
  let allowReviewCreates = false;

  for (const row of merged) {
    if (row.kind === "keep" && row.currentId != null) {
      matchedExistingIds.push(row.currentId);
      continue;
    }
    if (row.kind === "move" && row.currentId != null && row.fileTeam && row.teamOrder != null) {
      assertSlotFree(occupants, merged, row.name, row.fileTeam, row.teamOrder);
      updates.push({
        id: row.currentId,
        team: row.fileTeam,
        teamOrder: row.teamOrder,
      });
      matchedExistingIds.push(row.currentId);
      continue;
    }
    if (row.kind === "create" && row.fileTeam && row.teamOrder != null) {
      assertSlotFree(occupants, merged, row.name, row.fileTeam, row.teamOrder);
      creates.push({
        name: row.name,
        team: row.fileTeam,
        teamOrder: row.teamOrder,
      });
      continue;
    }
    if (row.kind === "needsReview" && row.asCreate && row.fileTeam && row.teamOrder != null) {
      allowReviewCreates = true;
      assertSlotFree(occupants, merged, row.name, row.fileTeam, row.teamOrder);
      creates.push({
        name: row.name,
        team: row.fileTeam,
        teamOrder: row.teamOrder,
      });
      continue;
    }
    if (row.kind === "needsReview" && row.matchId != null && row.fileTeam) {
      const cand = row.candidates.find((c) => c.id === row.matchId)!;
      matchedExistingIds.push(row.matchId);
      if (cand.team === row.fileTeam) {
        continue;
      }
      if (row.teamOrder == null) {
        throw new XlsxV1SafeApplyError(`${row.name}: 조 이동 순번이 필요합니다.`);
      }
      assertSlotFree(occupants, merged, row.name, row.fileTeam, row.teamOrder);
      updates.push({
        id: row.matchId,
        team: row.fileTeam,
        teamOrder: row.teamOrder,
      });
    }
  }

  return applyRosterImportPayloadV2(
    { updates, creates, matchedExistingIds },
    prisma,
    {
      existingForGuard: existing,
      allowExplicitNeedsReviewCreates: allowReviewCreates,
    }
  );
}
