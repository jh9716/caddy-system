/**
 * Abort Prisma / tsx processes that point DATABASE_URL at production,
 * unless this is the deployed app, a named read-only inspect tool,
 * or an explicit PROD_MAINTENANCE_CONFIRM task.
 *
 * Do not add ALLOW_PROD_DB=1.
 */
"use strict";

function parseUrl(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function isProductionUrl(url) {
  if (!url) return false;
  const parsed = parseUrl(url);
  if (!parsed) return false;
  const host = parsed.hostname || "";
  if (
    host.includes("neon.tech") ||
    host.includes("vercel-storage") ||
    host.includes("amazonaws.com") ||
    host.includes("verthill")
  ) {
    return true;
  }
  return Boolean(
    process.env.PRODUCTION_DATABASE_URL &&
      process.env.PRODUCTION_DATABASE_URL === url
  );
}

function isDeployedApp() {
  if (process.env.VERCEL === "1") return true;
  const args = process.argv.join(" ");
  return /next(?:\/dist|\/bin)|next-server/.test(args);
}

function isReadonlyInspectArgv() {
  const s = process.argv.join(" ");
  return /inspect-db-schema-readonly|check-migration-checksums-readonly|export-caddies-snapshot|preview-roster-import|inspect-special-assign-prod-readonly/.test(
    s
  );
}

function abort(url) {
  if (!isProductionUrl(url)) return;
  if (process.env.PROD_MAINTENANCE_CONFIRM) {
    console.error(
      "[db-safety] production URL with PROD_MAINTENANCE_CONFIRM=" +
        process.env.PROD_MAINTENANCE_CONFIRM
    );
    return;
  }
  if (isReadonlyInspectArgv()) {
    console.error("[db-safety] production READ-ONLY inspect tool allowed");
    return;
  }
  if (isDeployedApp()) return;
  const host = (parseUrl(url) && parseUrl(url).hostname) || "?";
  throw new Error(
    "⛔ Production/Neon DATABASE_URL 차단 (host=" +
      host +
      "). fixture/test/seed/ad-hoc Prisma write는 localhost만 허용. 운영 write는 PROD_MAINTENANCE_CONFIRM=<task> 가 있는 전용 maintenance 스크립트만 가능."
  );
}

abort(process.env.DATABASE_URL);

try {
  const Module = require("module");
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    const exported = originalLoad.apply(this, arguments);
    if (request !== "@prisma/client") return exported;
    if (!exported || !exported.PrismaClient || exported.PrismaClient.__dbSafetyGuarded) {
      return exported;
    }
    const Orig = exported.PrismaClient;
    class GuardedPrismaClient extends Orig {
      constructor(options) {
        const url =
          (options &&
            options.datasources &&
            options.datasources.db &&
            options.datasources.db.url) ||
          process.env.DATABASE_URL;
        abort(url);
        super(options);
      }
    }
    GuardedPrismaClient.__dbSafetyGuarded = true;
    exported.PrismaClient = GuardedPrismaClient;
    return exported;
  };
} catch {
  // ignore if require patch is unavailable
}
