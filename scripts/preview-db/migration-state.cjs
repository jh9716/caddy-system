// Preview DB migration 상태 판정 (순수 함수, DB 접속 없음).
// 기대 migration 은 하드코딩하지 않고 체크아웃된 ref 의 prisma/migrations 디렉터리에서 도출한다.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const MIGRATION_DIR_RE = /^\d{14}_[a-z0-9_]+$/;

/** repo 의 migration 이름 목록 (정렬). 형식 위반·migration.sql 누락 시 throw. */
function listRepoMigrations(migrationsDir) {
  const names = fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  if (names.length === 0) throw new Error("no migrations in repo");
  for (const n of names) {
    if (!MIGRATION_DIR_RE.test(n)) throw new Error(`invalid migration dir name: ${n}`);
    if (!fs.existsSync(path.join(migrationsDir, n, "migration.sql"))) {
      throw new Error(`migration.sql missing: ${n}`);
    }
  }
  if (new Set(names).size !== names.length) throw new Error("duplicate migration names");
  return names;
}

/**
 * 상태:
 * - EMPTY: public 테이블/객체 0
 * - UNEXPECTED_NON_PRISMA: 테이블은 있는데 _prisma_migrations 없음
 * - UNEXPECTED_PRISMA_STATE: 실패/롤백 migration 존재 또는 repo 에 없는(unknown) migration 적용됨
 * - MIGRATED: 적용된 집합 == repo 집합 (이름 완전 일치, 실패 0)
 * - PARTIALLY_MIGRATED: 적용 집합이 repo 집합의 진부분집합
 */
function classifyMigrationState({ tables, otherObjects, hasPm, applied, failed, repo }) {
  const repoSet = new Set(repo);
  const appliedSet = new Set(applied);
  const unknown = applied.filter((m) => !repoSet.has(m));
  const missing = repo.filter((m) => !appliedSet.has(m));
  let state;
  if (tables === 0 && otherObjects === 0) state = "EMPTY";
  else if (!hasPm) state = "UNEXPECTED_NON_PRISMA";
  else if (failed > 0 || unknown.length > 0 || appliedSet.size !== applied.length) {
    state = "UNEXPECTED_PRISMA_STATE";
  } else if (missing.length === 0) state = "MIGRATED";
  else state = "PARTIALLY_MIGRATED";
  return { state, missing, unknown, expected: repo.length };
}

module.exports = { listRepoMigrations, classifyMigrationState, MIGRATION_DIR_RE };
