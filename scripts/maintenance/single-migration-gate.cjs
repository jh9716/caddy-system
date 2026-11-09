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

function isCommentRepliesPreviewBranch(refName) {
  return COMMENT_REPLIES_BRANCH_RE.test(String(refName || ""));
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
 * Extra Preview migrate-gate for comment-replies branches only.
 * Other preview-db-* branches should skip and keep the generic EMPTY/PARTIAL rule.
 *
 * @returns {{ action: 'skip' | 'allow' | 'hold', reason: string }}
 */
function gateCommentRepliesPreviewMigrate(input) {
  const refName = input && input.refName;
  if (!isCommentRepliesPreviewBranch(refName)) {
    return { action: "skip", reason: "not a comment-replies preview branch" };
  }
  if (input.previewProjectId !== PREVIEW_PROJECT_ID) {
    return {
      action: "hold",
      reason: `preview project is not ${PREVIEW_PROJECT_ID}`,
    };
  }
  const neonEndpoint = input.neonEndpoint;
  if (neonEndpoint && neonEndpoint !== "n/a" && neonEndpoint !== PREVIEW_NEON_ENDPOINT) {
    return { action: "hold", reason: "neon endpoint is not Preview" };
  }
  if (/ep-crimson-cell|morning-tooth-60659454/.test(String(neonEndpoint || ""))) {
    return { action: "hold", reason: "production endpoint" };
  }

  const first = gateSingleMigration({
    target: COMMENT_REPLIES_MIGRATION,
    repo: input.repo,
    appliedFinished: input.appliedFinished,
    failedNames: input.failedNames,
    statusPending: input.statusPending,
  });
  const second = gateSingleMigration({
    target: COMMENT_REPLIES_MIGRATION,
    repo: input.repoAgain != null ? input.repoAgain : input.repo,
    appliedFinished:
      input.appliedFinishedAgain != null ? input.appliedFinishedAgain : input.appliedFinished,
    failedNames: input.failedNamesAgain != null ? input.failedNamesAgain : input.failedNames,
    statusPending: input.statusPendingAgain != null ? input.statusPendingAgain : input.statusPending,
  });
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

module.exports = {
  parsePrismaMigrateStatusPending,
  gateSingleMigration,
  gateCommentRepliesPreviewMigrate,
  isCommentRepliesPreviewBranch,
  COMMENT_REPLIES_MIGRATION,
  PREVIEW_PROJECT_ID,
  PREVIEW_NEON_ENDPOINT,
};
