/**
 * Cold/stale OFF-sheet cache vs persist SoT (no DB, no Google).
 * 실행: npx tsx scripts/test-off-sheet-cold-cache-unit.ts
 */
import {
  recoverComputePool,
  uniquePositiveIds,
} from "../src/lib/caddyPoolCanonical";
import {
  resolveCanonicalOffSheet,
} from "../src/lib/caddyPoolCanonicalService";
import {
  getOffSheetHttpFetchCount,
  invalidateOffSheetCache,
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
