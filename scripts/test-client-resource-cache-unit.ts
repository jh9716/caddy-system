/**
 * In-memory SWR cache + wiring. DB 없음.
 *   npm run test:client-resource-cache-unit
 */
import fs from "node:fs";
import path from "path";
import {
  CLIENT_RESOURCE,
  CLIENT_RESOURCE_TTL_MS,
  authNamespaceKey,
  clientAuthNamespaceFromMeUser,
  clientResourceStoreKey,
  clearClientResourceCache,
  applyRemoteClientResourceCacheClear,
  invalidateClientResource,
  isClientResourceCacheServerIdle,
  peekLastNamespaceResource,
  readClientResource,
  readLastClientAuthNamespace,
  releaseClientResourceCacheStoreForTests,
  rememberClientAuthNamespace,
  resetClientResourceCacheForTests,
  runDedupedClientResource,
  sameAuthNamespace,
  shouldApplyScopedResponse,
  shouldSkipFreshResourceRefresh,
  writeClientResource,
  CLIENT_RESOURCE_MAX_ENTRIES,
  type ClientAuthNamespace,
} from "../src/lib/clientResourceCache";
import { dashboardUpdatingCopy, boardPendingCopy } from "../src/lib/pendingLoad";

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

function read(rel: string) {
  return fs.readFileSync(path.resolve(rel), "utf8");
}

function section(title: string) {
  console.log("\n==", title, "==");
}

const alice: ClientAuthNamespace = {
  userId: 1,
  username: "alice",
  role: "caddy",
  sessionVersion: 1,
};
const aliceV2: ClientAuthNamespace = { ...alice, sessionVersion: 2 };
const bob: ClientAuthNamespace = {
  userId: 2,
  username: "bob",
  role: "caddy",
  sessionVersion: 1,
};

resetClientResourceCacheForTests();

section("miss / hit / stale");
{
  assert(readClientResource(alice, CLIENT_RESOURCE.BOARD, "2026-10-01") === null, "miss");
  writeClientResource(alice, CLIENT_RESOURCE.BOARD, "2026-10-01", { date: "2026-10-01" }, 1_000);
  const fresh = readClientResource(
    alice,
    CLIENT_RESOURCE.BOARD,
    "2026-10-01",
    1_000 + 5_000,
    CLIENT_RESOURCE_TTL_MS.board
  );
  assert(fresh?.fresh === true && (fresh.value as { date: string }).date === "2026-10-01", "fresh hit");
  const stale = readClientResource(
    alice,
    CLIENT_RESOURCE.BOARD,
    "2026-10-01",
    1_000 + 31_000,
    CLIENT_RESOURCE_TTL_MS.board
  );
  assert(stale != null && stale.fresh === false, "stale hit still readable");
  writeClientResource(alice, CLIENT_RESOURCE.BOARD, "2026-10-01", { date: "2026-10-01", v: 2 }, 40_000);
  const replaced = readClientResource<{ v?: number }>(alice, CLIENT_RESOURCE.BOARD, "2026-10-01", 40_100);
  assert(replaced?.value.v === 2, "replace overwrites");
}

section("invalidate");
{
  writeClientResource(alice, CLIENT_RESOURCE.BOARD, "2026-10-02", { date: "2026-10-02" });
  invalidateClientResource(alice, CLIENT_RESOURCE.BOARD, "2026-10-01");
  assert(readClientResource(alice, CLIENT_RESOURCE.BOARD, "2026-10-01") === null, "invalidate one date");
  assert(readClientResource(alice, CLIENT_RESOURCE.BOARD, "2026-10-02") != null, "other date kept");
  invalidateClientResource(alice, CLIENT_RESOURCE.BOARD);
  assert(readClientResource(alice, CLIENT_RESOURCE.BOARD, "2026-10-02") === null, "invalidate resource prefix");
}

section("user / session / date isolation");
{
  writeClientResource(alice, CLIENT_RESOURCE.BOARD, "2026-10-01", { owner: "alice" });
  writeClientResource(bob, CLIENT_RESOURCE.BOARD, "2026-10-01", { owner: "bob" });
  assert(
    (readClientResource<{ owner: string }>(alice, CLIENT_RESOURCE.BOARD, "2026-10-01")?.value.owner ===
      "alice"),
    "alice isolated from bob"
  );
  assert(
    (readClientResource<{ owner: string }>(bob, CLIENT_RESOURCE.BOARD, "2026-10-01")?.value.owner ===
      "bob"),
    "bob isolated from alice"
  );
  assert(
    readClientResource(aliceV2, CLIENT_RESOURCE.BOARD, "2026-10-01") === null,
    "sessionVersion isolation"
  );
  writeClientResource(alice, CLIENT_RESOURCE.OFF_CALENDAR, "2026-10", { month: "2026-10" });
  assert(
    readClientResource(alice, CLIENT_RESOURCE.OFF_CALENDAR, "2026-11") === null,
    "month isolation"
  );
  assert(authNamespaceKey(alice) !== authNamespaceKey(bob), "namespace keys differ");
  assert(!sameAuthNamespace(alice, aliceV2), "version bump is new namespace");
  assert(
    !clientResourceStoreKey(alice, "board", "2026-10-01").includes("cookie") &&
      !clientResourceStoreKey(alice, "board", "2026-10-01").includes("token"),
    "store key has no token words"
  );
}

section("last namespace peek + clear");
{
  rememberClientAuthNamespace(alice);
  writeClientResource(alice, CLIENT_RESOURCE.DASHBOARD, "2026-10-01", { date: "2026-10-01" });
  const peek = peekLastNamespaceResource<{ date: string }>(
    CLIENT_RESOURCE.DASHBOARD,
    "2026-10-01",
    (value) => value.date === "2026-10-01"
  );
  assert(peek?.value.date === "2026-10-01", "peek last ns");
  assert(
    peekLastNamespaceResource<{ date: string }>(
      CLIENT_RESOURCE.DASHBOARD,
      "2026-10-01",
      (value) => value.date === "2026-10-02"
    ) === null,
    "peek rejects other date"
  );
  clearClientResourceCache();
  assert(readLastClientAuthNamespace() === null, "clear drops last ns");
  assert(readClientResource(alice, CLIENT_RESOURCE.DASHBOARD, "2026-10-01") === null, "clear drops store");
}

section("stale response guard");
{
  assert(
    shouldApplyScopedResponse({
      requestGen: 2,
      latestGen: 2,
      selectedKey: "2026-10-01",
      responseKey: "2026-10-01",
    }),
    "current gen + matching date applies"
  );
  assert(
    !shouldApplyScopedResponse({
      requestGen: 1,
      latestGen: 2,
      selectedKey: "2026-10-01",
      responseKey: "2026-10-01",
    }),
    "older gen ignored"
  );
  assert(
    !shouldApplyScopedResponse({
      requestGen: 2,
      latestGen: 2,
      selectedKey: "2026-10-02",
      responseKey: "2026-10-01",
    }),
    "other date ignored"
  );
}

section("me user parse");
{
  assert(
    clientAuthNamespaceFromMeUser({
      id: 9,
      username: "admin",
      role: "admin",
      sessionVersion: 4,
    })?.userId === 9,
    "parses /api/me user"
  );
  assert(clientAuthNamespaceFromMeUser({ username: "x" }) === null, "role required");
  const envAdmin = clientAuthNamespaceFromMeUser({
    username: "admin",
    role: "admin",
    sessionVersion: 0,
  });
  assert(envAdmin?.userId === null && envAdmin.username === "admin", "env admin uses username");
}

section("refresh copy");
{
  assert(
    dashboardUpdatingCopy({ loading: false, hasData: true, staleDate: false, error: true }) ===
      "갱신 실패",
    "same-date dash refresh failure"
  );
  assert(
    boardPendingCopy({
      loading: false,
      selectedDate: "2026-10-01",
      publishedDate: "2026-10-01",
      error: true,
    }) === "갱신 실패",
    "same-date board refresh failure"
  );
}

section("server idle / no process Map");
{
  releaseClientResourceCacheStoreForTests();
  assert(isClientResourceCacheServerIdle(), "server has no store");
  writeClientResource(alice, CLIENT_RESOURCE.BOARD, "2026-10-01", { leak: true });
  assert(
    readClientResource(alice, CLIENT_RESOURCE.BOARD, "2026-10-01") === null,
    "server write is a no-op"
  );
  resetClientResourceCacheForTests();
}

section("fresh skip helper");
{
  writeClientResource(alice, CLIENT_RESOURCE.BOARD, "2026-10-01", { date: "2026-10-01" }, 1_000);
  const fresh = readClientResource(alice, CLIENT_RESOURCE.BOARD, "2026-10-01", 1_000 + 1_000);
  const stale = readClientResource(alice, CLIENT_RESOURCE.BOARD, "2026-10-01", 1_000 + 31_000);
  assert(shouldSkipFreshResourceRefresh(fresh), "fresh skips resource API");
  assert(!shouldSkipFreshResourceRefresh(stale), "stale still revalidates");
  assert(!shouldSkipFreshResourceRefresh(null), "miss does not skip");
}

section("memory prune");
{
  resetClientResourceCacheForTests();
  rememberClientAuthNamespace(alice);
  for (let i = 0; i < CLIENT_RESOURCE_MAX_ENTRIES + 8; i++) {
    writeClientResource(alice, CLIENT_RESOURCE.BOARD, `d${i}`, { i }, i * 1_000);
  }
  assert(
    readClientResource(alice, CLIENT_RESOURCE.BOARD, "d0") === null,
    "oldest evicted"
  );
  assert(
    readClientResource(alice, CLIENT_RESOURCE.BOARD, `d${CLIENT_RESOURCE_MAX_ENTRIES + 7}`) !=
      null,
    "newest kept"
  );
  writeClientResource(alice, CLIENT_RESOURCE.BOARD, "old", { v: 1 }, 1);
  writeClientResource(
    alice,
    CLIENT_RESOURCE.BOARD,
    "new",
    { v: 2 },
    1 + 31 * 60 * 1000
  );
  assert(
    readClientResource(alice, CLIENT_RESOURCE.BOARD, "old", 1 + 31 * 60 * 1000) === null,
    "max-age evicts on write"
  );
}

section("remote tab clear");
{
  resetClientResourceCacheForTests();
  rememberClientAuthNamespace(alice);
  writeClientResource(alice, CLIENT_RESOURCE.BOARD, "2026-10-01", { owner: "alice" });
  applyRemoteClientResourceCacheClear();
  assert(readLastClientAuthNamespace() === null, "remote clear drops ns");
  assert(
    readClientResource(alice, CLIENT_RESOURCE.BOARD, "2026-10-01") === null,
    "remote clear drops store"
  );
}

section("no durable storage");
{
  const cache = read("src/lib/clientResourceCache.ts");
  assert(!/localStorage\.(get|set|remove)/.test(cache), "no localStorage API");
  assert(!/sessionStorage\.(get|set|remove)/.test(cache), "no sessionStorage API");
  assert(!/indexedDB\./.test(cache), "no idb API");
  assert(!cache.includes("caches.open"), "no Cache Storage");
  assert(cache.includes("Never tokens"), "token policy comment");
}

section("logout / login / 401 clear");
{
  const logout = read("src/lib/logoutClient.ts");
  const login = read("src/app/login/LoginClient.tsx");
  const member = read("src/lib/memberSessionRedirect.ts");
  assert(logout.includes("clearClientResourceCache()"), "logout clears");
  assert(login.includes("clearClientResourceCache()"), "login submit clears");
  assert(member.includes("clearClientResourceCache()"), "401 clears");
}

section("page wiring");
{
  const board = read("src/app/board/page.tsx");
  const comments = read("src/app/board/BoardComments.tsx");
  const cal = read("src/app/off-requests/OffRequestCalendarClient.tsx");
  const dash = read("src/components/manage/AdminOpsDashboard.tsx");
  const caddy = read("src/app/caddy/page.tsx");
  const roster = read("src/app/manage/caddies/page.tsx");
  const cache = read("src/lib/clientResourceCache.ts");
  assert(board.includes("CLIENT_RESOURCE.BOARD"), "board cache");
  assert(board.includes("peekLastNamespaceResource"), "board peek");
  assert(board.includes("useState<PublishedResponse[\"published\"]>(() => {"), "board first paint from cache");
  assert(board.includes("next.date !== ymd"), "board date guard");
  assert(comments.includes("useState<CommentPublic[]>(() => {"), "comments first paint from cache");
  assert(cal.includes("useState<CalendarDto | null>(() => {"), "calendar first paint from cache");
  assert(dash.includes("useState<AdminOpsDashboardView | null>(() => {"), "dashboard first paint from cache");
  assert(roster.includes("useState<Caddy[]>(() => {"), "roster first paint from cache");
  assert(comments.includes("CLIENT_RESOURCE.BOARD_COMMENTS"), "comments cache");
  assert(comments.includes("rememberComments"), "comment mutation writes cache");
  assert(!/setComments\(\[\]\)/.test(comments.split("useEffect")[1] ?? "") || comments.includes("cached"), "comments keep cache");
  assert(cal.includes("CLIENT_RESOURCE.OFF_CALENDAR"), "calendar cache");
  assert(cal.includes("invalidateClientResource"), "calendar mutation invalidate");
  assert(cal.includes("value.month === nextMonth"), "month match");
  assert(dash.includes("CLIENT_RESOURCE.DASHBOARD"), "dashboard cache");
  assert(dash.includes("value.date === ymd"), "dashboard date match");
  assert(dash.includes("clearClientResourceCache()"), "dashboard 401 clears");
  assert(caddy.includes("Promise.all"), "caddy parallel mine/summary");
  assert(caddy.includes("check-role"), "caddy keeps check-role gate");
  assert(caddy.includes("CLIENT_RESOURCE.CADDY_SUMMARY"), "caddy summary cache");
  assert(caddy.includes("!summary && (loading || !allowed)"), "caddy no wipe when cached");
  assert(caddy.includes("peekSafeCaddySummary"), "caddy first paint from last ns");
  assert(caddy.includes("ns.role !== 'caddy' && ns.role !== 'leader'"), "caddy peek requires caddy/leader ns");
  assert(roster.includes("CLIENT_RESOURCE.CADDY_ROSTER"), "roster cache");
  assert(roster.includes("reloadAfterMutation"), "roster mutation invalidate");
  assert(roster.includes("CLIENT_RESOURCE.DASHBOARD"), "caddy mutation invalidates dashboard");
  assert(roster.includes("loading && rows.length === 0"), "roster keep list");
  assert(roster.includes("RETIRED"), "retired filter still present");
  assert(board.includes("shouldSkipFreshResourceRefresh"), "board fresh skip");
  assert(cal.includes("shouldSkipFreshResourceRefresh"), "calendar fresh skip");
  assert(dash.includes("shouldSkipFreshResourceRefresh"), "dashboard fresh skip");
  assert(dash.includes("isDashboardSheetFreshPayload"), "dashboard skips only sheet-fresh cache");
  assert(dash.includes("refresh=1") || dash.includes('refresh", "1"'), "dashboard background refresh");
  assert(roster.includes("shouldSkipFreshResourceRefresh"), "roster fresh skip");
  assert(cache.includes("BroadcastChannel"), "cross-tab channel");
  assert(cache.includes("typeof window"), "browser-only store guard");
}

void (async () => {
  section("inflight dedupe");
  {
    let runs = 0;
    const p1 = runDedupedClientResource("k", async () => {
      runs += 1;
      await new Promise((r) => setTimeout(r, 20));
      return "one";
    });
    const p2 = runDedupedClientResource("k", async () => {
      runs += 1;
      return "two";
    });
    const [a, b] = await Promise.all([p1, p2]);
    assert(a === "one" && b === "one", "dedupe shares the first promise");
    assert(runs === 1, "dedupe runs once");
  }

  if (failed > 0) {
    console.error(`\nclient-resource-cache failed: ${failed} (passed ${passed})`);
    process.exit(1);
  }
  console.log(`\nclient-resource-cache passed: ${passed}`);
})();
