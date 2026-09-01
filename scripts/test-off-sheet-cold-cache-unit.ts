/**
 * Cold/stale OFF-sheet cache vs persist SoT (no DB, no Google).
 * 실행: npx tsx scripts/test-off-sheet-cold-cache-unit.ts
 */
import {
  OFF_SHEET_UNRESOLVED_CODE,
  OFF_SHEET_UNRESOLVED_USER_MESSAGE,
  recoverComputePool,
  uniquePositiveIds,
} from "../src/lib/caddyPoolCanonical";
import {
  OFF_SHEET_RESOLVE_TIMEOUT_MS,
  isOffSheetUnresolvedError,
  resetOffDateInflightForTests,
  resolveCanonicalOffSheet,
} from "../src/lib/caddyPoolCanonicalService";
import { resolveCanonicalLivePool } from "../src/lib/opsDutyLivePool";
import {
  getOffSheetHttpFetchCount,
  invalidateOffSheetCache,
  OffSheetError,
  peekCachedOffSheetsForDate,
  resetOffSheetHttpStatsForTests,
  seedOffSheetCacheForTests,
  setPublishedOffSheetLoaderForTests,
} from "../src/lib/offSheetFetch";
import type { OffSheet } from "../src/lib/offSheetParser";
import type { AutoAssignCaddy } from "../src/lib/autoAssignEngine";

let passed = 0;
let failed = 0;
function assert(cond: unknown, msg: string) {
  if (cond) {
    passed++;
    console.log("  ✓", msg);
  } else {
    failed++;
    console.error("  ✗", msg);
  }
}
function section(title: string) {
  console.log("\n==", title, "==");
}

function house(id: number, name: string): AutoAssignCaddy {
  return {
    id,
    name,
    team: `${((id - 1) % 8) + 1}조`,
    teamOrder: Math.floor((id - 1) / 8),
    caddyType: "HOUSE",
    employmentStatus: "ACTIVE",
  };
}

function offSheetForDate(ymd: string, names: string[]): OffSheet {
  const [y, m, d] = ymd.split("-");
  return {
    name: `${m}${d}`,
    matrix: [
      [`${y}.${m}.${d} (월)`, "", ""],
      ["1조", "2조", "3조"],
      [names[0] || "", names[1] || "", names[2] || ""],
    ],
  };
}

const DATE = "2026-08-28";
const OTHER = "2026-08-01";
const working = house(1, "근무자");
const sick = house(2, "병가자");
const offCaddy = house(3, "휴무자");
const spare = house(4, "스페어후보");
const clientPolluted = [working, sick, offCaddy, spare];
const sotUsable = [working, spare];

async function main() {
  section("cache-only miss resurrects OFF in compute pool");
  {
    invalidateOffSheetCache();
    resetOffSheetHttpStatsForTests();
    const resolved = await resolveCanonicalOffSheet(DATE, "cache");
    assert(resolved.source === "miss", "cold cache-only is miss");
    assert(!resolved.matched, "cache-only miss is not date-matched");
    assert(getOffSheetHttpFetchCount() === 0, "cache-only miss does not HTTP");
    const compute = recoverComputePool({
      clientPool: clientPolluted,
      sotUsable,
      offSheetMatched: resolved.matched,
      unavailableIds: [sick.id],
    });
    assert(
      compute.some((c) => c.id === offCaddy.id),
      "cache-only miss would admit OFF from polluted client (merge blocker)"
    );
  }

  section("cold cache-or-fetch loads today's OFF SoT once");
  {
    invalidateOffSheetCache();
    resetOffSheetHttpStatsForTests();
    setPublishedOffSheetLoaderForTests(async () => [
      offSheetForDate(DATE, [offCaddy.name]),
    ]);
    const resolved = await resolveCanonicalOffSheet(DATE, "cache-or-fetch");
    assert(resolved.source === "fetch", "cold persist fetches OFF");
    assert(resolved.matched, "fetched workbook matches today");
    assert(resolved.names.includes(offCaddy.name), "today OFF name from fetch");
    assert(getOffSheetHttpFetchCount() === 1, "exactly one OFF HTTP on cold miss");
    const second = await resolveCanonicalOffSheet(DATE, "cache-or-fetch");
    assert(second.source === "cache", "second persist reuses date-matched cache");
    assert(getOffSheetHttpFetchCount() === 1, "no second HTTP within TTL");
    const compute = recoverComputePool({
      clientPool: clientPolluted,
      sotUsable: sotUsable,
      offSheetMatched: resolved.matched,
      unavailableIds: [sick.id],
    });
    assert(!compute.some((c) => c.id === offCaddy.id), "OFF not in compute");
    assert(!compute.some((c) => c.id === sick.id), "SICK not in compute");
    assert(compute.some((c) => c.id === working.id), "working stays");
    assert(compute.some((c) => c.id === spare.id), "spare candidate stays");
  }

  section("stale other-date cache is not reused for today");
  {
    invalidateOffSheetCache();
    resetOffSheetHttpStatsForTests();
    seedOffSheetCacheForTests([offSheetForDate(OTHER, ["어제휴무"])]);
    assert(peekCachedOffSheetsForDate(OTHER) !== null, "other date is in cache");
    assert(peekCachedOffSheetsForDate(DATE) === null, "today is not in other-date cache");
    setPublishedOffSheetLoaderForTests(async () => [
      offSheetForDate(DATE, [offCaddy.name]),
    ]);
    const resolved = await resolveCanonicalOffSheet(DATE, "cache-or-fetch");
    assert(resolved.source === "fetch", "unmatched cache forces fetch");
    assert(resolved.names.includes(offCaddy.name), "today OFF not yesterday's name");
    assert(!resolved.names.includes("어제휴무"), "stale other-date names dropped");
    assert(getOffSheetHttpFetchCount() === 1, "stale date miss fetches once");
  }

  section("4s OFF fetch delay is not a timeout miss");
  {
    invalidateOffSheetCache();
    resetOffSheetHttpStatsForTests();
    assert(
      OFF_SHEET_RESOLVE_TIMEOUT_MS > 4000,
      "persist timeout allows a 4s OFF fetch"
    );
    setPublishedOffSheetLoaderForTests(async () => {
      await new Promise((resolve) => setTimeout(resolve, 4100));
      return [offSheetForDate(DATE, [offCaddy.name])];
    });
    const started = Date.now();
    const resolved = await resolveCanonicalOffSheet(DATE, "cache-or-fetch");
    const elapsed = Date.now() - started;
    assert(elapsed >= 4000, `persist waited for slow OFF fetch (${elapsed}ms)`);
    assert(elapsed < OFF_SHEET_RESOLVE_TIMEOUT_MS, "4s fetch did not hit timeout");
    assert(resolved.source === "fetch", "slow fetch is not timeout miss");
    assert(resolved.matched, "workbook still date-matched after 4s");
    assert(resolved.names.includes(offCaddy.name), "today OFF SoT after 4s delay");
    assert(getOffSheetHttpFetchCount() === 1, "slow fetch is still one HTTP");
    const compute = recoverComputePool({
      clientPool: clientPolluted,
      sotUsable,
      offSheetMatched: resolved.matched,
      unavailableIds: [sick.id],
    });
    assert(!compute.some((c) => c.id === offCaddy.id), "OFF stays out after slow fetch");
  }

  section("forced OFF HTTP 500 fails closed — no client pool fallback");
  {
    invalidateOffSheetCache();
    resetOffSheetHttpStatsForTests();
    setPublishedOffSheetLoaderForTests(async () => {
      throw new OffSheetError("forced 500", "off_sheet_fetch_failed", 500);
    });
    let thrown: unknown = null;
    try {
      await resolveCanonicalOffSheet(DATE, "cache-or-fetch");
    } catch (error) {
      thrown = error;
    }
    assert(isOffSheetUnresolvedError(thrown), "500 becomes OffSheetUnresolvedError");
    assert(
      thrown instanceof Error && thrown.message === OFF_SHEET_UNRESOLVED_USER_MESSAGE,
      "500 uses persist fail-safe user message"
    );
    assert(
      isOffSheetUnresolvedError(thrown) && thrown.code === OFF_SHEET_UNRESOLVED_CODE,
      "500 code is OFF_SHEET_UNRESOLVED"
    );
    let liveThrown: unknown = null;
    try {
      await resolveCanonicalLivePool(DATE, clientPolluted, {
        offSheetMode: "cache-or-fetch",
        computeClientPool: clientPolluted,
      });
    } catch (error) {
      liveThrown = error;
    }
    assert(
      isOffSheetUnresolvedError(liveThrown),
      "live pool does not swallow OFF 500 into client fallback"
    );
    assert(getOffSheetHttpFetchCount() >= 1, "500 path still attempted HTTP");
  }

  section("OFF fetch past timeout fails closed — no client pool fallback");
  {
    invalidateOffSheetCache();
    resetOffSheetHttpStatsForTests();
    assert(OFF_SHEET_RESOLVE_TIMEOUT_MS === 15_000, "production persist timeout stays 15s");
    setPublishedOffSheetLoaderForTests(async () => {
      await new Promise((resolve) => setTimeout(resolve, 180));
      return [offSheetForDate(DATE, [offCaddy.name])];
    });
    const started = Date.now();
    let thrown: unknown = null;
    try {
      await resolveCanonicalOffSheet(DATE, "cache-or-fetch", { timeoutMs: 60 });
    } catch (error) {
      thrown = error;
    }
    const elapsed = Date.now() - started;
    assert(isOffSheetUnresolvedError(thrown), "timeout is OffSheetUnresolvedError");
    assert(
      thrown instanceof Error && thrown.message === OFF_SHEET_UNRESOLVED_USER_MESSAGE,
      "timeout uses persist fail-safe user message"
    );
    assert(elapsed >= 60, `timeout waited at least the limit (${elapsed}ms)`);
    assert(elapsed < 1500, `timeout did not wait for the late fetch (${elapsed}ms)`);
    invalidateOffSheetCache();
    process.env.OFF_SHEET_RESOLVE_TIMEOUT_MS = "60";
    let liveThrown: unknown = null;
    try {
      try {
        await resolveCanonicalLivePool(DATE, clientPolluted, {
          offSheetMode: "cache-or-fetch",
          computeClientPool: clientPolluted,
        });
      } catch (error) {
        liveThrown = error;
      }
    } finally {
      delete process.env.OFF_SHEET_RESOLVE_TIMEOUT_MS;
    }
    assert(
      isOffSheetUnresolvedError(liveThrown),
      "live pool does not admit OFF after timeout"
    );
  }

  section("date-matched cache hit stays local and fast");
  {
    invalidateOffSheetCache();
    resetOffSheetHttpStatsForTests();
    seedOffSheetCacheForTests([offSheetForDate(DATE, [offCaddy.name])]);
    const started = Date.now();
    const resolved = await resolveCanonicalOffSheet(DATE, "cache-or-fetch");
    const elapsed = Date.now() - started;
    assert(resolved.source === "cache", "date-matched cache is a hit");
    assert(resolved.matched, "cache hit is date-matched");
    assert(resolved.names.includes(offCaddy.name), "cache hit keeps today OFF names");
    assert(getOffSheetHttpFetchCount() === 0, "cache hit does 0 HTTP");
    assert(elapsed < 20, `cache hit stays fast (${elapsed}ms)`);
    const compute = recoverComputePool({
      clientPool: clientPolluted,
      sotUsable,
      offSheetMatched: resolved.matched,
      unavailableIds: [sick.id],
    });
    assert(!compute.some((c) => c.id === offCaddy.id), "cache hit keeps OFF out");
  }

  section("overlapping cache-or-fetch shares one in-flight HTTP");
  {
    invalidateOffSheetCache();
    resetOffSheetHttpStatsForTests();
    resetOffDateInflightForTests();
    setPublishedOffSheetLoaderForTests(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return [offSheetForDate(DATE, [offCaddy.name])];
    });
    const started = Date.now();
    const [a, b] = await Promise.all([
      resolveCanonicalOffSheet(DATE, "cache-or-fetch"),
      resolveCanonicalOffSheet(DATE, "cache-or-fetch"),
    ]);
    const elapsed = Date.now() - started;
    assert(a.matched && b.matched, "both waiters get today's OFF");
    assert(getOffSheetHttpFetchCount() === 1, "overlap single-flight is 1 HTTP");
    assert(elapsed < 1500, `overlap waited once (${elapsed}ms)`);
    const third = await resolveCanonicalOffSheet(DATE, "cache-or-fetch");
    assert(third.source === "cache", "verified date snapshot reused after flight");
    assert(getOffSheetHttpFetchCount() === 1, "post-flight persist does not HTTP");
  }

  section("same-request skipCanonicalReload does not fetch twice");
  {
    invalidateOffSheetCache();
    resetOffSheetHttpStatsForTests();
    setPublishedOffSheetLoaderForTests(async () => [
      offSheetForDate(DATE, [offCaddy.name]),
    ]);
    const first = await resolveCanonicalOffSheet(DATE, "cache-or-fetch");
    const reused = await resolveCanonicalOffSheet(DATE, "cache");
    assert(first.source === "fetch" && reused.source === "cache", "route fetch + apply cache");
    assert(getOffSheetHttpFetchCount() === 1, "skip second load: 1 HTTP total");
    assert(uniquePositiveIds([sick.id]).includes(2), "unavailable helper still works");
  }

  setPublishedOffSheetLoaderForTests(null);
  invalidateOffSheetCache();
  console.log(`\nDONE: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
