// Production/Preview: decide whether exactly one named Prisma migration may be applied.
// Pure function + prisma migrate status parser. No DB connection.
"use strict";

/**
 * Parse `prisma migrate status` stdout/stderr for pending migration directory names.
 * Status is read-only; this does not apply migrations.
 */
function parsePrismaMigrateStatusPending(statusOut) {
  const pending = [];
  const lines = String(statusOut || "").split(/\r?\n/);
  let inPending = false;
  for (const line of lines) {
    if (/have not yet been applied/i.test(line)) {
      inPending = true;
      continue;
    }
    if (inPending) {
      const name = line.trim();
      if (!name) {
        inPending = false;
        continue;
      }
      if (/^To apply migrations/i.test(name) || /^Database schema is up to date/i.test(name)) {
        inPending = false;
        continue;
      }
      if (/^[0-9]{14}_/.test(name)) pending.push(name);
    }
  }
  if (/Database schema is up to date/i.test(String(statusOut || ""))) return [];
  return pending;
}

/**
 * Allow prisma migrate deploy only when the sole pending migration is `target`.
 * Failed, unknown, duplicate, or extra pending migrations → hold.
 *
 * @param {{
 *   target: string,
 *   repo: string[],
 *   appliedFinished: string[],
 *   failedNames: string[],
 *   statusPending: string[],
 * }} input
 */
function gateSingleMigration(input) {
  const target = input.target;
  const repo = Array.isArray(input.repo) ? input.repo : [];
  const appliedFinished = Array.isArray(input.appliedFinished) ? input.appliedFinished : [];
  const failedNames = Array.isArray(input.failedNames) ? input.failedNames : [];
  const statusPending = Array.isArray(input.statusPending) ? input.statusPending : [];

  const repoSet = new Set(repo);
  const appliedSet = new Set(appliedFinished);
  const unknownApplied = [...new Set(appliedFinished.filter((m) => !repoSet.has(m)))];
  const pendingFromRepo = repo.filter((m) => !appliedSet.has(m));
  const unexpectedPending = pendingFromRepo.filter((m) => m !== target);
  const statusUnexpected = statusPending.filter((m) => m !== target);
  const appliedHasDupes = appliedSet.size !== appliedFinished.length;

  const base = {
    pendingFromRepo,
    unexpectedPending,
    unknownApplied,
    statusPending,
    statusUnexpected,
  };

  if (failedNames.length > 0) {
    return {
      action: "hold",
      reason: `failed migrations ${JSON.stringify(failedNames)}`,
      ...base,
    };
  }
  if (appliedHasDupes) {
    return { action: "hold", reason: "duplicate applied migration rows", ...base };
  }
  if (unknownApplied.length > 0) {
    return {
      action: "hold",
      reason: `unknown applied migrations ${JSON.stringify(unknownApplied)}`,
      ...base,
    };
  }
  if (unexpectedPending.length > 0) {
    return {
      action: "hold",
      reason: `unexpected pending migrations ${JSON.stringify(unexpectedPending)}`,
      ...base,
    };
  }
  if (statusUnexpected.length > 0) {
    return {
      action: "hold",
      reason: `prisma status unexpected pending ${JSON.stringify(statusUnexpected)}`,
      ...base,
    };
  }

  const targetApplied = appliedSet.has(target);
  const statusHasTarget = statusPending.includes(target);
  const statusEmpty = statusPending.length === 0;

  if (targetApplied) {
    if (pendingFromRepo.length !== 0) {
      return {
        action: "hold",
        reason: "target applied in DB but repo still lists it pending",
        ...base,
      };
    }
    if (statusHasTarget) {
      return {
        action: "hold",
        reason: "target finished in DB but prisma status still lists it pending",
        ...base,
      };
    }
    if (!statusEmpty) {
      return {
        action: "hold",
        reason: `prisma status pending ${JSON.stringify(statusPending)} after target applied`,
        ...base,
      };
    }
    return { action: "already-applied", reason: "target already finished", ...base };
  }

  const repoExact = pendingFromRepo.length === 1 && pendingFromRepo[0] === target;
  const statusExact = statusPending.length === 1 && statusPending[0] === target;
  if (repoExact && statusExact) {
    return { action: "deploy", reason: "only target migration is pending", ...base };
  }
  return {
    action: "hold",
    reason: `pending set is not exactly [${target}] (repo=${JSON.stringify(pendingFromRepo)} status=${JSON.stringify(statusPending)})`,
    ...base,
  };
}

const COMMENT_REPLIES_MIGRATION = "20261109193000_comment_replies_v1";
const PREVIEW_PROJECT_ID = "lucky-mode-29989630";
const PREVIEW_NEON_ENDPOINT = "ep-odd-voice-aokrqp5t";
const COMMENT_REPLIES_BRANCH_RE = /^preview-db-comment-replies-.+/;

// PR #380 자유게시판 V1 — Preview 전용 단일 migration gate (정확한 브랜치 이름만).
const COMMUNITY_FREE_BOARD_MIGRATION = "20261120160000_community_free_board_v1";
const COMMUNITY_FREE_BOARD_MIGRATION_SHA256 = "b284927f596d25861baefe4ab2859e50307996e22c3585dd467344883a756a4f";
const COMMUNITY_FREE_BOARD_EXPECTED_APPLIED = 66;
const COMMUNITY_FREE_BOARD_BRANCH = "preview-db-pr380-community-free-board";

function isCommentRepliesPreviewBranch(refName) {
  return COMMENT_REPLIES_BRANCH_RE.test(String(refName || ""));
}

function isCommunityFreeBoardPreviewBranch(refName) {
  return String(refName || "") === COMMUNITY_FREE_BOARD_BRANCH;
}

function listsEqual(a, b) {
  const left = Array.isArray(a) ? a : [];
  const right = Array.isArray(b) ? b : [];
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

/**
 * Extra Preview migrate-gate for a named single-migration branch.
 * Reuses gateSingleMigration; requires Preview project/endpoint and a stable pending set.
 * spec.extraCheck(snapshot) → null (ok) | reason string (hold). Applied to both reads.
 *
 * @returns {{ action: 'skip' | 'allow' | 'hold', reason: string }}
 */
function gatePreviewNamedSingleMigration(input, spec) {
  const refName = input && input.refName;
  if (!spec.isTargetBranch(refName)) {
    return { action: "skip", reason: spec.skipReason };
  }
  if (input.previewProjectId !== PREVIEW_PROJECT_ID) {
    return {
      action: "hold",
      reason: `preview project is not ${PREVIEW_PROJECT_ID}`,
    };
  }
  const neonEndpoint = input.neonEndpoint;
  if (spec.requireExactEndpoint && neonEndpoint !== PREVIEW_NEON_ENDPOINT) {
    return { action: "hold", reason: "neon endpoint is not exactly Preview" };
  }
  if (neonEndpoint && neonEndpoint !== "n/a" && neonEndpoint !== PREVIEW_NEON_ENDPOINT) {
    return { action: "hold", reason: "neon endpoint is not Preview" };
  }
  if (/ep-crimson-cell|morning-tooth-60659454/.test(String(neonEndpoint || ""))) {
    return { action: "hold", reason: "production endpoint" };
  }

  const firstSnap = {
    repo: input.repo,
    appliedFinished: input.appliedFinished,
    failedNames: input.failedNames,
    statusPending: input.statusPending,
    repoChecksums: input.repoChecksums,
    appliedChecksums: input.appliedChecksums,
    dbError: input.dbError,
  };
  const secondSnap = {
    repo: input.repoAgain != null ? input.repoAgain : input.repo,
    appliedFinished:
      input.appliedFinishedAgain != null ? input.appliedFinishedAgain : input.appliedFinished,
    failedNames: input.failedNamesAgain != null ? input.failedNamesAgain : input.failedNames,
    statusPending: input.statusPendingAgain != null ? input.statusPendingAgain : input.statusPending,
    repoChecksums: input.repoChecksumsAgain != null ? input.repoChecksumsAgain : input.repoChecksums,
    appliedChecksums:
      input.appliedChecksumsAgain != null ? input.appliedChecksumsAgain : input.appliedChecksums,
    dbError: input.dbErrorAgain != null ? input.dbErrorAgain : input.dbError,
  };
  if (typeof spec.extraCheck === "function") {
    for (const snap of [firstSnap, secondSnap]) {
      let extra;
      try {
        extra = spec.extraCheck(snap);
      } catch (e) {
        extra = `extra check error (${e && e.message ? e.message : "unknown"})`;
      }
      if (extra) return { action: "hold", reason: extra };
    }
  }

  const first = gateSingleMigration({ target: spec.target, ...firstSnap });
  const second = gateSingleMigration({ target: spec.target, ...secondSnap });
  if (
    first.action !== second.action ||
    first.reason !== second.reason ||
    !listsEqual(first.pendingFromRepo, second.pendingFromRepo)
  ) {
    return { action: "hold", reason: "migration list changed between checks" };
  }
  if (first.action !== "deploy") {
    return { ...first, action: "hold", reason: first.reason };
  }
  return { ...first, action: "allow", reason: first.reason };
}

/**
 * Extra Preview migrate-gate for comment-replies branches only.
 * Other preview-db-* branches should skip and keep the generic EMPTY/PARTIAL rule
 * unless they have their own named gate.
 */
function gateCommentRepliesPreviewMigrate(input) {
  return gatePreviewNamedSingleMigration(input, {
    isTargetBranch: isCommentRepliesPreviewBranch,
    skipReason: "not a comment-replies preview branch",
    target: COMMENT_REPLIES_MIGRATION,
  });
}

/**
 * PR #380 전용 추가 검사 (fail-closed). 하나라도 어긋나면 이유 문자열을 돌려준다.
 * - DB 조회 오류 없음
 * - repo 67개 = 기존 66개 + 대상 1개, 대상이 repo 마지막
 * - 적용 완료 66개 정확히, 실패·롤백 0
 * - 대상 migration.sql SHA-256 = 고정값
 * - 적용된 모든 migration 의 DB checksum = repo migration.sql SHA-256
 */
function communityFreeBoardExtraCheck(snap) {
  if (!snap || snap.dbError) return `db read error (${snap && snap.dbError ? String(snap.dbError) : "no snapshot"})`;
  const repo = Array.isArray(snap.repo) ? snap.repo : null;
  const applied = Array.isArray(snap.appliedFinished) ? snap.appliedFinished : null;
  const failed = Array.isArray(snap.failedNames) ? snap.failedNames : null;
  const repoSums = snap.repoChecksums && typeof snap.repoChecksums === "object" ? snap.repoChecksums : null;
  const dbSums = snap.appliedChecksums && typeof snap.appliedChecksums === "object" ? snap.appliedChecksums : null;
  if (!repo || !applied || !failed || !repoSums || !dbSums) return "incomplete gate input";
  if (failed.length !== 0) return `failed or rolled-back migrations ${JSON.stringify(failed)}`;
  if (repo.length !== COMMUNITY_FREE_BOARD_EXPECTED_APPLIED + 1) {
    return `repo migrations ${repo.length} != ${COMMUNITY_FREE_BOARD_EXPECTED_APPLIED + 1}`;
  }
  if (repo[repo.length - 1] !== COMMUNITY_FREE_BOARD_MIGRATION) return "target is not the last repo migration";
  if (applied.length !== COMMUNITY_FREE_BOARD_EXPECTED_APPLIED) {
    return `applied migrations ${applied.length} != ${COMMUNITY_FREE_BOARD_EXPECTED_APPLIED}`;
  }
  if (repoSums[COMMUNITY_FREE_BOARD_MIGRATION] !== COMMUNITY_FREE_BOARD_MIGRATION_SHA256) {
    return "target migration.sql sha256 mismatch";
  }
  for (const name of applied) {
    const r = repoSums[name];
    const d = dbSums[name];
    if (!r || !d) return `checksum missing for ${name}`;
    if (r !== d) return `checksum mismatch for ${name}`;
  }
  return null;
}

/**
 * PR #380 자유게시판 V1 전용 Preview migrate-gate.
 * 정확한 브랜치 이름에서만 동작하고, endpoint 는 정확히 Preview 여야 한다.
 */
function gateCommunityFreeBoardPreviewMigrate(input) {
  try {
    return gatePreviewNamedSingleMigration(input, {
      isTargetBranch: isCommunityFreeBoardPreviewBranch,
      skipReason: "not the PR #380 community-free-board preview branch",
      target: COMMUNITY_FREE_BOARD_MIGRATION,
      requireExactEndpoint: true,
      extraCheck: communityFreeBoardExtraCheck,
    });
  } catch (e) {
    return { action: "hold", reason: `gate error (${e && e.message ? e.message : "unknown"})` };
  }
}

module.exports = {
  parsePrismaMigrateStatusPending,
  gateSingleMigration,
  gatePreviewNamedSingleMigration,
  gateCommentRepliesPreviewMigrate,
  gateCommunityFreeBoardPreviewMigrate,
  communityFreeBoardExtraCheck,
  isCommentRepliesPreviewBranch,
  isCommunityFreeBoardPreviewBranch,
  COMMENT_REPLIES_MIGRATION,
  COMMUNITY_FREE_BOARD_MIGRATION,
  COMMUNITY_FREE_BOARD_MIGRATION_SHA256,
  COMMUNITY_FREE_BOARD_EXPECTED_APPLIED,
  COMMUNITY_FREE_BOARD_BRANCH,
  PREVIEW_PROJECT_ID,
  PREVIEW_NEON_ENDPOINT,
};
