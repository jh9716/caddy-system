/**
 * 커뮤니티 자유게시판 V1 Production migration 안전장치 — 순수 함수 (DB 연결 없음).
 *
 * 대상: 20261120160000_community_free_board_v1 (additive: enum 값 1개 + 새 enum + 새 테이블 2개).
 * 운영 식별값(host/endpoint/branch/project/db)은 기존 team-affiliation 절차의 상수를 그대로 재사용한다
 * (teamAffiliationProd.ts 는 수정하지 않음). 와일드카드 없음 — 정확히 일치만 허용.
 *
 * 모드 분리:
 *   precheck : 읽기 전용. PROD_MAINTENANCE_CONFIRM=COMMUNITY_FREE_BOARD_V1_PRECHECK_20261121
 *              PROD_DB_CONFIRM="PROD-DB-PRECHECK morning-tooth-60659454 20261120160000_community_free_board_v1"
 *   migrate  : prisma migrate deploy 1회. PROD_MAINTENANCE_CONFIRM=COMMUNITY_FREE_BOARD_V1_MIGRATE_20261121
 *              PROD_DB_CONFIRM="PROD-DB-MIGRATE morning-tooth-60659454 20261120160000_community_free_board_v1"
 *              + NEON_PITR_WINDOW_CONFIRMED=YES + NEON_BACKUP_BRANCH=backup-pre-pr380-prod-YYYYMMDD
 * 모드와 확인 문구·task id 가 하나라도 어긋나면 DB 연결 전에 차단한다.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  EXPECTED_BRANCH_ID,
  EXPECTED_DB,
  EXPECTED_ENDPOINT_ID,
  EXPECTED_HOST,
  EXPECTED_PROJECT_ID,
  PITR_CONFIRM,
  assertProductionEndpoint,
  stripSqlComments,
} from "./teamAffiliationProd";

export {
  EXPECTED_BRANCH_ID,
  EXPECTED_DB,
  EXPECTED_ENDPOINT_ID,
  EXPECTED_HOST,
  EXPECTED_PROJECT_ID,
  assertProductionEndpoint,
};

export const ROOT = path.resolve(__dirname, "../..");
export const MIGRATION_NAME = "20261120160000_community_free_board_v1";
export const SQL_REL = path.join("prisma", "migrations", MIGRATION_NAME, "migration.sql");
/** 대상 migration.sql 의 sha256 (Prisma _prisma_migrations.checksum 과 같은 방식). 코드에 고정. */
export const PINNED_TARGET_SHA256 = "b284927f596d25861baefe4ab2859e50307996e22c3585dd467344883a756a4f";

export const PREVIEW_PROJECT_ID = "lucky-mode-29989630";
export const PREVIEW_ENDPOINT_ID = "ep-odd-voice-aokrqp5t";

export type Mode = "precheck" | "migrate";

export const TASK_IDS: Record<Mode, string> = {
  precheck: "COMMUNITY_FREE_BOARD_V1_PRECHECK_20261121",
  migrate: "COMMUNITY_FREE_BOARD_V1_MIGRATE_20261121",
};

export function confirmPhrase(mode: Mode): string {
  return `PROD-DB-${mode.toUpperCase()} ${EXPECTED_PROJECT_ID} ${MIGRATION_NAME}`;
}

export const BACKUP_BRANCH_RE = /^backup-pre-pr380-prod-20[0-9]{6}$/;

export const NEW_TABLES = ["CommunityPost", "CommunityPhoto"] as const;
export const NEW_ENUM = "CommunityBoardType";
export const ENUM_VALUE = { type: "CommentTargetType", value: "COMMUNITY_POST" } as const;
export const EXPECTED_INDEXES = [
  "CommunityPost_pkey",
  "CommunityPhoto_pkey",
  "CommunityPost_boardType_deletedAt_createdAt_idx",
  "CommunityPost_authorUserId_idx",
  "CommunityPhoto_storageKey_key",
  "CommunityPhoto_postId_sortOrder_idx",
] as const;
export const EXPECTED_FKS: Record<string, string> = {
  CommunityPost_authorUserId_fkey: "RESTRICT",
  CommunityPhoto_postId_fkey: "CASCADE",
};

/** 실행 전후 지문을 비교할 기존 테이블 (존재해야 함). */
export const FINGERPRINT_TABLES = [
  "User",
  "Caddy",
  "DailyBoardPublished",
  "FreeBoardPost",
  "FreeBoardPhoto",
  "CommentThread",
  "Comment",
] as const;

export function sha256Bytes(buf: Buffer | string): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

export function migrationChecksum(root: string, name: string): string {
  return sha256Bytes(fs.readFileSync(path.join(root, "prisma", "migrations", name, "migration.sql")));
}

/** repo 의 모든 migration checksum (이름 → sha256). */
export function repoChecksums(root: string, names: string[]): Record<string, string> {
  return Object.fromEntries(names.map((n) => [n, migrationChecksum(root, n)]));
}

type Env = Record<string, string | undefined>;

/** 모드·task id·확인 문구 검증. DB 연결 전에 호출. 실패 시 throw. */
export function resolveModeAndConfirm(env: Env): Mode {
  const raw = env.PROD_DB_MODE;
  if (raw !== "precheck" && raw !== "migrate") {
    throw new Error("HOLD: PROD_DB_MODE must be exactly precheck or migrate");
  }
  const mode: Mode = raw;
  const other: Mode = mode === "precheck" ? "migrate" : "precheck";
  if (env.PROD_MAINTENANCE_CONFIRM !== TASK_IDS[mode]) {
    if (env.PROD_MAINTENANCE_CONFIRM === TASK_IDS[other]) {
      throw new Error(`HOLD: mode confusion — task id is for ${other}, mode is ${mode}`);
    }
    throw new Error(`HOLD: PROD_MAINTENANCE_CONFIRM must be ${TASK_IDS[mode]}`);
  }
  if (env.PROD_DB_CONFIRM !== confirmPhrase(mode)) {
    if (env.PROD_DB_CONFIRM === confirmPhrase(other)) {
      throw new Error(`HOLD: mode confusion — confirm phrase is for ${other}, mode is ${mode}`);
    }
    throw new Error("HOLD: PROD_DB_CONFIRM phrase missing or wrong");
  }
  if (mode === "migrate") {
    if (env.NEON_PITR_WINDOW_CONFIRMED !== PITR_CONFIRM) {
      throw new Error("HOLD: migrate requires NEON_PITR_WINDOW_CONFIRMED=YES (Neon console check)");
    }
    if (!BACKUP_BRANCH_RE.test(env.NEON_BACKUP_BRANCH ?? "")) {
      throw new Error("HOLD: migrate requires NEON_BACKUP_BRANCH=backup-pre-pr380-prod-YYYYMMDD");
    }
  }
  return mode;
}

/** URL 검증: 운영 host/db 정확히 일치, Preview·pooler 거부. 값은 출력하지 않음. */
export function assertCommunityProdUrl(url: string | undefined): { host: string } {
  if (!url) throw new Error("HOLD: DATABASE_URL missing");
  const lower = url.toLowerCase();
  if (lower.includes(PREVIEW_ENDPOINT_ID) || lower.includes(PREVIEW_PROJECT_ID)) {
    throw new Error("HOLD: Preview endpoint/project refused");
  }
  const r = assertProductionEndpoint(url);
  if (!r.ok) throw new Error(`HOLD: production endpoint check failed (${r.reason})`);
  if (r.host !== EXPECTED_HOST) throw new Error("HOLD: host mismatch");
  return { host: r.host };
}

export type NeonIdentity = { database: string; endpoint: string; branch: string };

/** DB 안에서 본 식별값. endpoint/branch 는 Neon 이 노출하는 경우 정확히 일치해야 한다. */
export function assertNeonIdentity(ident: NeonIdentity): void {
  if (ident.database !== EXPECTED_DB) throw new Error(`HOLD: current_database ${ident.database} != ${EXPECTED_DB}`);
  for (const v of [ident.endpoint, ident.branch]) {
    if (v.includes(PREVIEW_ENDPOINT_ID) || v.includes(PREVIEW_PROJECT_ID)) {
      throw new Error("HOLD: Preview identity refused");
    }
  }
  if (ident.endpoint !== "n/a" && ident.endpoint !== EXPECTED_ENDPOINT_ID) {
    throw new Error(`HOLD: neon.endpoint_id ${ident.endpoint} != ${EXPECTED_ENDPOINT_ID}`);
  }
  if (ident.branch !== "n/a" && ident.branch !== EXPECTED_BRANCH_ID) {
    throw new Error(`HOLD: neon.branch_id ${ident.branch} != ${EXPECTED_BRANCH_ID}`);
  }
}

/** 대상 SQL 감사: additive 만, 기존 테이블 ALTER/DROP/DML 금지, 기대 객체 존재. */
export function auditCommunityMigrationSql(sql: string): void {
  const body = stripSqlComments(sql);
  const upper = body.toUpperCase();
  const forbidden = [
    /\bDROP\b/,
    /\bTRUNCATE\b/,
    /\bINSERT\b/,
    /\bDELETE\s+FROM\b/,
    /\bUPDATE\s+"?[A-Z0-9_]+"?\s+SET\b/,
    /\bRENAME\b/,
    /\bSET\s+DATA\s+TYPE\b/,
    /\bALTER\s+COLUMN\b/,
    /\bREINDEX\b/,
    /\bVACUUM\b/,
    /\bGRANT\b/,
    /\bREVOKE\b/,
  ];
  for (const re of forbidden) {
    if (re.test(upper)) throw new Error(`HOLD: migration.sql contains forbidden token ${re}`);
  }
  const alterTables = [...body.matchAll(/ALTER\s+TABLE\s+"([^"]+)"/gi)].map((m) => m[1]);
  for (const t of alterTables) {
    if (!(NEW_TABLES as readonly string[]).includes(t)) {
      throw new Error(`HOLD: migration.sql must not ALTER existing table ${t}`);
    }
  }
  const alterTypes = [...body.matchAll(/ALTER\s+TYPE\s+"([^"]+)"\s+([^;]+);/gi)];
  for (const m of alterTypes) {
    if (m[1] !== ENUM_VALUE.type || !/^ADD\s+VALUE\s+IF\s+NOT\s+EXISTS\s+'COMMUNITY_POST'$/i.test(m[2].trim())) {
      throw new Error(`HOLD: unexpected ALTER TYPE ${m[1]}`);
    }
  }
  if (alterTypes.length !== 1) throw new Error("HOLD: expected exactly one ALTER TYPE ADD VALUE");
  for (const t of NEW_TABLES) {
    if (!new RegExp(`CREATE\\s+TABLE\\s+"${t}"`, "i").test(body)) throw new Error(`HOLD: expected CREATE TABLE ${t}`);
  }
  const created = [...body.matchAll(/CREATE\s+TABLE\s+"([^"]+)"/gi)].map((m) => m[1]);
  if (created.length !== NEW_TABLES.length) throw new Error("HOLD: unexpected CREATE TABLE count");
  if (!/CREATE\s+TYPE\s+"CommunityBoardType"\s+AS\s+ENUM\s*\(\s*'FREE'\s*\)/i.test(body)) {
    throw new Error("HOLD: expected CREATE TYPE CommunityBoardType ('FREE')");
  }
  for (const idx of EXPECTED_INDEXES.filter((n) => !n.endsWith("_pkey"))) {
    if (!body.includes(`"${idx}"`)) throw new Error(`HOLD: expected index ${idx}`);
  }
  for (const [fk, rule] of Object.entries(EXPECTED_FKS)) {
    const re = new RegExp(`CONSTRAINT\\s+"${fk}"[^;]*ON\\s+DELETE\\s+${rule}`, "i");
    if (!re.test(body)) throw new Error(`HOLD: expected FK ${fk} ON DELETE ${rule}`);
  }
}

/** 로컬 대상 파일 checksum 이 코드 고정값과 같아야 한다. */
export function assertPinnedTargetChecksum(localSha: string): void {
  if (localSha !== PINNED_TARGET_SHA256) {
    throw new Error("HOLD: local target migration.sql checksum differs from pinned value");
  }
}

export type AppliedRow = {
  migration_name: string;
  checksum: string;
  finished_at: Date | string | null;
  rolled_back_at: Date | string | null;
};

export type MigrationState = {
  appliedFinished: string[];
  failedNames: string[];
  checksumByName: Record<string, string>;
  duplicateNames: string[];
};

export function summarizeMigrationRows(rows: AppliedRow[]): MigrationState {
  const finished = rows.filter((r) => r.finished_at && !r.rolled_back_at);
  const appliedFinished = finished.map((r) => r.migration_name);
  const failedNames = [
    ...new Set(rows.filter((r) => !r.finished_at || r.rolled_back_at).map((r) => r.migration_name)),
  ];
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.migration_name)) dup.add(r.migration_name);
    seen.add(r.migration_name);
  }
  const checksumByName = Object.fromEntries(finished.map((r) => [r.migration_name, r.checksum]));
  return { appliedFinished, failedNames, checksumByName, duplicateNames: [...dup] };
}

/**
 * 이미 적용된 migration checksum 이 repo 파일과 모두 같은지.
 * DB 에는 있는데 repo 파일이 없는 이름도 여기서 잡는다.
 */
export function compareAppliedChecksums(
  state: MigrationState,
  repoSums: Record<string, string>
): { mismatched: string[]; missingInRepo: string[] } {
  const mismatched: string[] = [];
  const missingInRepo: string[] = [];
  for (const [name, sum] of Object.entries(state.checksumByName)) {
    if (!(name in repoSums)) missingInRepo.push(name);
    else if (repoSums[name] !== sum) mismatched.push(name);
  }
  return { mismatched: mismatched.sort(), missingInRepo: missingInRepo.sort() };
}

export type GateFn = (input: {
  target: string;
  repo: string[];
  appliedFinished: string[];
  failedNames: string[];
  statusPending: string[];
}) => { action: "deploy" | "already-applied" | "hold"; reason: string; pendingFromRepo: string[] };

export type SchemaProbe = {
  tables: string[];
  enumTypeExists: boolean;
  enumValueExists: boolean;
  indexes: string[];
  fks: Record<string, string>;
  rowCounts: Record<string, number>;
};

export type Decision =
  | { action: "hold"; reason: string }
  | { action: "already-applied"; reason: string }
  | { action: "ready"; reason: string };

/**
 * 하나의 판정 함수. precheck 와 migrate 둘 다 이 결과가 "ready" 여야 다음 단계로 간다.
 * 차단: 실패/롤백 기록, 중복, 미지(파일 없음), checksum 불일치, 대상 외 대기, 대기 0/2+,
 *       migration 미기록인데 새 객체가 이미 있음.
 */
export function decideCommunityMigration(input: {
  gate: GateFn;
  repo: string[];
  repoSums: Record<string, string>;
  state: MigrationState;
  statusPending: string[];
  probe: SchemaProbe;
}): Decision {
  const { state, repoSums, repo } = input;
  if (!repo.includes(MIGRATION_NAME)) return { action: "hold", reason: "target migration missing in repo" };
  if (repoSums[MIGRATION_NAME] !== PINNED_TARGET_SHA256) {
    return { action: "hold", reason: "target checksum differs from pinned value" };
  }
  if (state.duplicateNames.length > 0) {
    return { action: "hold", reason: `duplicate _prisma_migrations rows ${JSON.stringify(state.duplicateNames)}` };
  }
  if (state.failedNames.length > 0) {
    return { action: "hold", reason: `failed or rolled-back migrations ${JSON.stringify(state.failedNames)}` };
  }
  const sums = compareAppliedChecksums(state, repoSums);
  if (sums.missingInRepo.length > 0) {
    return { action: "hold", reason: `applied in DB but missing in repo ${JSON.stringify(sums.missingInRepo)}` };
  }
  if (sums.mismatched.length > 0) {
    return { action: "hold", reason: `applied checksum mismatch ${JSON.stringify(sums.mismatched)}` };
  }
  const g = input.gate({
    target: MIGRATION_NAME,
    repo,
    appliedFinished: state.appliedFinished,
    failedNames: state.failedNames,
    statusPending: input.statusPending,
  });
  if (g.action === "hold") return { action: "hold", reason: g.reason };
  if (g.action === "already-applied") {
    return { action: "already-applied", reason: "target already finished; nothing to deploy" };
  }
  // deploy 후보: 새 객체가 하나라도 이미 있으면 기록과 실제가 어긋난 것 → 차단
  const p = input.probe;
  const present = NEW_TABLES.filter((t) => p.tables.includes(t));
  if (present.length > 0 || p.enumTypeExists || p.enumValueExists) {
    return { action: "hold", reason: "community objects exist but migration is not recorded" };
  }
  return { action: "ready", reason: "only target migration is pending; all checks passed" };
}

/** 적용 후 스키마 검증. */
export function assertCommunitySchemaAfter(p: SchemaProbe, opts: { requireEmpty: boolean }): void {
  for (const t of NEW_TABLES) if (!p.tables.includes(t)) throw new Error(`HOLD: table ${t} missing after deploy`);
  if (!p.enumTypeExists) throw new Error(`HOLD: enum ${NEW_ENUM} missing after deploy`);
  if (!p.enumValueExists) throw new Error("HOLD: CommentTargetType.COMMUNITY_POST missing after deploy");
  for (const i of EXPECTED_INDEXES) if (!p.indexes.includes(i)) throw new Error(`HOLD: index ${i} missing`);
  for (const [fk, rule] of Object.entries(EXPECTED_FKS)) {
    if (p.fks[fk] !== rule) throw new Error(`HOLD: FK ${fk} rule ${p.fks[fk] ?? "missing"} != ${rule}`);
  }
  if (!opts.requireEmpty) return;
  for (const t of NEW_TABLES) {
    if (p.rowCounts[t] !== 0) throw new Error(`HOLD: ${t} must be empty right after migrate (no seed)`);
  }
}

export type Fingerprint = { total: number; fingerprint: string };

/** 기존 테이블 지문 비교: 실행 전 존재하던 행(id ≤ 실행 전 max id)의 수·지문이 같아야 한다. */
export function compareFingerprints(
  before: Record<string, Fingerprint>,
  after: Record<string, Fingerprint>
): string[] {
  const changed: string[] = [];
  for (const [t, b] of Object.entries(before)) {
    const a = after[t];
    if (!a || a.total !== b.total || a.fingerprint !== b.fingerprint) changed.push(t);
  }
  return changed;
}

/** prisma 는 migrate status / migrate deploy(추가 플래그 없음)만 허용. reset·push·resolve·dev·seed 거부. */
export function allowedPrismaArgs(args: string[]): boolean {
  if (args.length !== 2 || args[0] !== "migrate") return false;
  return args[1] === "status" || args[1] === "deploy";
}

export function listsEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
