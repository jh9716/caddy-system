/**
 * Pure helpers for Production team-affiliation migrate (no DB connection).
 * Deploy still requires PROD_MAINTENANCE_CONFIRM + NEON_PITR_WINDOW_CONFIRMED.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseDatabaseUrl } from "../../src/lib/dbSafety";

export const ROOT = path.resolve(__dirname, "../..");
export const TASK_ID = "TEAM_AFFILIATION_SETTINGS_20261117";
export const MIGRATION_NAME = "20261117233000_team_affiliation_settings";
export const EXPECTED_HOST = "ep-crimson-cell-a1i1tpce.ap-southeast-1.aws.neon.tech";
export const EXPECTED_DB = "neondb";
export const EXPECTED_PROJECT_ID = "morning-tooth-60659454";
export const EXPECTED_ENDPOINT_ID = "ep-crimson-cell-a1i1tpce";
export const EXPECTED_BRANCH_ID = "br-calm-tree-a1fa8ozg";
export const PITR_CONFIRM = "YES";
export const SQL_REL = path.join("prisma", "migrations", MIGRATION_NAME, "migration.sql");

export const PREVIEW_MARKERS = [
  "ep-odd-voice-aokrqp5t",
  "lucky-mode-29989630",
  "pooler",
  "pgbouncer",
] as const;

export const EXPECTED_INDEXES = [
  "TeamAffiliationVersion_pkey",
  "TeamAffiliationVersion_effectiveFrom_key",
  "TeamAffiliationVersion_effectiveFrom_idx",
  "TeamAffiliationItem_pkey",
  "TeamAffiliationItem_versionId_team_key",
  "TeamAffiliationItem_team_idx",
] as const;

export const EXPECTED_FK = "TeamAffiliationItem_versionId_fkey";

export function sha256Bytes(buf: Buffer | string): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

export function localMigrationChecksum(name: string): string {
  const p = path.join(ROOT, "prisma", "migrations", name, "migration.sql");
  return sha256Bytes(fs.readFileSync(p));
}

export function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

export function auditTeamAffiliationMigrationSql(sql: string): void {
  const body = stripSqlComments(sql);
  const upper = body.toUpperCase();
  const forbidden = [
    /\bDROP\b/,
    /\bTRUNCATE\b/,
    /\bINSERT\b/,
    /\bREWRITE\b/,
    /\bSET\s+DATA\s+TYPE\b/,
    /\bMIGRATE\s+RESET\b/,
    /\bMIGRATE\s+DEV\b/,
    /\bDELETE\s+FROM\b/,
    /\bUPDATE\s+"?[A-Z0-9_]+"?\s+SET\b/,
    /\bDB\s+PUSH\b/,
    /\bSEED\b/,
  ];
  for (const re of forbidden) {
    if (re.test(upper)) {
      throw new Error(`HOLD: migration.sql contains forbidden token ${re}`);
    }
  }
  if (/ALTER\s+TABLE\s+"Caddy"/i.test(body)) {
    throw new Error("HOLD: migration.sql must not ALTER Caddy");
  }
  if (/ALTER\s+TABLE\s+"DailyBoardPublished"/i.test(body)) {
    throw new Error("HOLD: migration.sql must not ALTER DailyBoardPublished");
  }
  if (/ALTER\s+TABLE\s+"User"/i.test(body)) {
    throw new Error("HOLD: migration.sql must not ALTER User");
  }
  if (!/CREATE\s+TABLE\s+"TeamAffiliationVersion"/i.test(body)) {
    throw new Error("HOLD: expected CREATE TABLE TeamAffiliationVersion");
  }
  if (!/CREATE\s+TABLE\s+"TeamAffiliationItem"/i.test(body)) {
    throw new Error("HOLD: expected CREATE TABLE TeamAffiliationItem");
  }
  if (!/TeamAffiliationVersion_effectiveFrom_key/i.test(body)) {
    throw new Error("HOLD: expected unique index on TeamAffiliationVersion.effectiveFrom");
  }
  if (!/TeamAffiliationItem_versionId_team_key/i.test(body)) {
    throw new Error("HOLD: expected unique index on TeamAffiliationItem(versionId, team)");
  }
  if (!/CONSTRAINT\s+"TeamAffiliationItem_versionId_fkey"/i.test(body)) {
    throw new Error("HOLD: expected TeamAffiliationItem versionId FK");
  }
  if (!/ON\s+DELETE\s+CASCADE/i.test(body)) {
    throw new Error("HOLD: TeamAffiliationItem FK must be ON DELETE CASCADE");
  }
}

export type HostCheck =
  | { ok: true; host: string; database: string }
  | { ok: false; reason: string };

export function assertProductionEndpoint(url: string): HostCheck {
  let parsed: URL;
  try {
    parsed = parseDatabaseUrl(url);
  } catch {
    return { ok: false, reason: "unparseable" };
  }
  const host = parsed.hostname;
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, "")).replace(/\?.*$/, "");
  const lower = url.toLowerCase();
  for (const m of PREVIEW_MARKERS) {
    if (lower.includes(m)) return { ok: false, reason: "preview_or_pooler" };
  }
  if (host !== EXPECTED_HOST) return { ok: false, reason: "host" };
  if (database !== EXPECTED_DB) return { ok: false, reason: "database" };
  if (parsed.port && parsed.port !== "5432") return { ok: false, reason: "port" };
  return { ok: true, host, database };
}

export function assertPitrConfirmed(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NEON_PITR_WINDOW_CONFIRMED !== PITR_CONFIRM) {
    throw new Error(
      "HOLD: production apply requires NEON_PITR_WINDOW_CONFIRMED=YES (Neon console PITR, not taken here)"
    );
  }
}

export function listsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export type SchemaProbe = {
  versionTable: boolean;
  itemTable: boolean;
  indexes: string[];
  fk: { name: string; deleteRule: string } | null;
  versionRows: number;
  itemRows: number;
};

export function assertTeamAffiliationSchema(probe: SchemaProbe): void {
  if (!probe.versionTable) throw new Error("HOLD: TeamAffiliationVersion table missing");
  if (!probe.itemTable) throw new Error("HOLD: TeamAffiliationItem table missing");
  for (const name of EXPECTED_INDEXES) {
    if (!probe.indexes.includes(name)) {
      throw new Error(`HOLD: missing index ${name}`);
    }
  }
  if (!probe.fk) throw new Error(`HOLD: ${EXPECTED_FK} missing`);
  if (probe.fk.deleteRule !== "CASCADE") {
    throw new Error(`HOLD: ${EXPECTED_FK} delete_rule ${probe.fk.deleteRule}, expected CASCADE`);
  }
}

export function assertEmptyAffiliationRows(probe: SchemaProbe): void {
  if (probe.versionRows !== 0) {
    throw new Error("HOLD: TeamAffiliationVersion must be empty after migrate (no seed)");
  }
  if (probe.itemRows !== 0) {
    throw new Error("HOLD: TeamAffiliationItem must be empty after migrate (no seed)");
  }
}
