import {
  isProductionDatabaseUrl,
  parseDatabaseUrl,
} from "../src/lib/dbSafety";

/**
 * Production write escape hatch.
 * Tests must never set this. Use a unique confirm token per maintenance task.
 */
export function requireProdMaintenance(taskId: string): { host: string; url: string } {
  const expected = process.env.PROD_MAINTENANCE_CONFIRM;
  if (!taskId || expected !== taskId) {
    throw new Error(
      `⛔ production maintenance 차단. 이 스크립트는 PROD_MAINTENANCE_CONFIRM=${taskId} 가 필요합니다. ALLOW_PROD_DB 같은 범용 스위치는 없습니다.`
    );
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL 이 없습니다.");
  const host = parseDatabaseUrl(url).hostname;
  if (!isProductionDatabaseUrl(url)) {
    throw new Error(
      `⛔ PROD_MAINTENANCE_CONFIRM 는 production DB 전용입니다. host=${host}`
    );
  }
  console.error("=== PRODUCTION MAINTENANCE ===");
  console.error("task:", taskId);
  console.error("host:", host);
  console.error("db:", parseDatabaseUrl(url).pathname);
  return { host, url };
}
