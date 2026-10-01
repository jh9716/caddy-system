/**
 * QA C4: assignments date URL + pending draft leave flush.
 * 실행: npm run test:assignments-c4-unit
 */
import fs from "node:fs";
import path from "node:path";
import {
  ASSIGNMENTS_OPS_PATH,
  assignmentsDateFromSearch,
  buildAssignmentsSearch,
  isAssignmentsOpsPath,
  parseAssignmentsDateParam,
  replaceAssignmentsDateUrl,
} from "../src/lib/assignmentsDateUrl";
import {
  decideDraftLeaveFlush,
  draftLeavePutKeepalive,
  shouldRetryDraftLeaveConflict,
} from "../src/lib/draftUnloadFlush";
import { drainDraftSaves } from "../src/lib/draftSaveFlush";

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

function readSrc(rel: string) {
  return fs.readFileSync(path.resolve(rel), "utf8");
}

async function main() {
section("A parse / URL date");
{
  assert(parseAssignmentsDateParam("2026-10-01") === "2026-10-01", "valid ymd");
  assert(parseAssignmentsDateParam(" 2026-10-01 ") === "2026-10-01", "trim valid ymd");
  assert(parseAssignmentsDateParam("2026-13-1") === null, "non YYYY-MM-DD ignored");
  assert(parseAssignmentsDateParam("2026/10/01") === null, "slash date ignored");
  assert(parseAssignmentsDateParam("https://evil.test") === null, "url-like ignored");
  assert(parseAssignmentsDateParam("") === null, "empty ignored");
  assert(assignmentsDateFromSearch("?date=2026-10-01") === "2026-10-01", "search hydrate");
  assert(assignmentsDateFromSearch("?date=nope&x=1") === null, "invalid search ignored");
  assert(assignmentsDateFromSearch("?foo=1") === null, "missing date");
  assert(
    buildAssignmentsSearch({ currentSearch: "", date: "2026-10-01" }) ===
      "?date=2026-10-01",
    "build date query"
  );
  assert(
    buildAssignmentsSearch({ currentSearch: "?date=2026-10-01", date: "2026-10-02" }) ===
      "?date=2026-10-02",
    "date change updates query"
  );
  assert(
    buildAssignmentsSearch({ currentSearch: "?date=2026-10-01", date: "" }) === "",
    "clear date removes param"
  );
  assert(
    buildAssignmentsSearch({
      currentSearch: "?date=not-a-date&tab=board",
      date: "",
    }) === "?tab=board",
    "invalid date stripped, other params kept"
  );
}

section("A/H replaceState is path-local");
{
  assert(isAssignmentsOpsPath(ASSIGNMENTS_OPS_PATH), "ops path ok");
  assert(!isAssignmentsOpsPath("/login"), "login rejected");
  assert(!isAssignmentsOpsPath("https://evil.test/manage/assignments"), "absolute rejected");
  assert(!isAssignmentsOpsPath("//evil.test"), "protocol-relative rejected");
  let written: string | null = null;
  const next = replaceAssignmentsDateUrl({
    pathname: "/manage/assignments",
    search: "",
    date: "2026-10-01",
    replaceState: (url) => {
      written = url;
    },
  });
  assert(next === "/manage/assignments?date=2026-10-01", "replace writes relative url");
  assert(written === "/manage/assignments?date=2026-10-01", "replaceState relative only");
  written = "touched";
  const same = replaceAssignmentsDateUrl({
    pathname: "/manage/assignments",
    search: "?date=2026-10-01",
    date: "2026-10-01",
    replaceState: (url) => {
      written = url;
    },
  });
  assert(same === "/manage/assignments?date=2026-10-01", "same url returned");
  assert(written === "touched", "same url does not replaceState");
  const blocked = replaceAssignmentsDateUrl({
    pathname: "/login",
    search: "",
    date: "2026-10-01",
    replaceState: (url) => {
      written = url;
    },
  });
  assert(blocked === null, "non-ops path does not write");
  assert(written === "touched", "blocked path no replaceState");
}

section("B/E leave flush gates");
{
  assert(
    decideDraftLeaveFlush({
      hydrating: true,
      pending: { date: "2026-10-01" },
      currentDate: "2026-10-01",
      inFlight: false,
    }).action === "skip",
    "hydrating flush 0"
  );
  assert(
    decideDraftLeaveFlush({
      hydrating: false,
      pending: null,
      currentDate: "2026-10-01",
      inFlight: false,
    }).action === "skip",
    "already saved / no pending flush 0"
  );
  assert(
    decideDraftLeaveFlush({
      hydrating: false,
      pending: { date: "2026-10-01" },
      currentDate: "2026-10-01",
      inFlight: true,
    }).action === "skip",
    "in-flight duplicate flush 0"
  );
  assert(
    decideDraftLeaveFlush({
      hydrating: false,
      pending: { date: "2026-10-01" },
      currentDate: "2026-10-02",
      inFlight: false,
    }).action === "skip",
    "date mismatch flush 0"
  );
  assert(
    decideDraftLeaveFlush({
      hydrating: false,
      pending: { date: "2026-10-01" },
      currentDate: "2026-10-01",
      inFlight: false,
    }).action === "flush",
    "pending pagehide flushes once"
  );
  assert(draftLeavePutKeepalive() === false, "draft leave PUT keepalive false");
  assert(shouldRetryDraftLeaveConflict() === false, "leave 409 no retry");
}

section("C/D/F drain + conflict no overwrite");
{
  let pending: { date: string } | null = { date: "2026-10-01" };
  let inFlight = false;
  let puts = 0;
  const flushed = await drainDraftSaves({
    hasPending: () => pending != null,
    isInFlight: () => inFlight,
    flushOnce: async () => {
      puts += 1;
      pending = null;
      return "ok";
    },
    clearDebounceTimer: () => {},
  });
  assert(flushed.status === "ok", "pending drain ok");
  assert(puts === 1, "pending save 1회");

  puts = 0;
  const idle = await drainDraftSaves({
    hasPending: () => false,
    isInFlight: () => false,
    flushOnce: async () => {
      puts += 1;
      return "ok";
    },
    clearDebounceTimer: () => {},
  });
  assert(idle.timings.skippedSave === true, "saved state skippedSave");
  assert(puts === 0, "already saved duplicate save 0");

  pending = { date: "2026-10-01" };
  puts = 0;
  let retried = false;
  const conflicted = await drainDraftSaves({
    hasPending: () => pending != null,
    isInFlight: () => false,
    flushOnce: async () => {
      puts += 1;
      pending = null;
      return "conflict";
    },
    clearDebounceTimer: () => {},
  });
  assert(conflicted.status === "conflict", "conflict returned");
  assert(puts === 1, "conflict PUT 1회");
  assert(pending === null, "conflict clears pending, no overwrite retry");
  assert(shouldRetryDraftLeaveConflict() === false && !retried, "no unload retry flag");
}

section("source: page wiring");
{
  const page = readSrc("src/app/manage/assignments/page.tsx");
  assert(
    page.includes("assignmentsDateFromSearch") &&
      page.includes("replaceAssignmentsDateUrl"),
    "page uses date URL helpers"
  );
  assert(page.includes('window.history.replaceState'), "date sync uses replaceState");
  assert(page.includes('addEventListener("popstate"'), "popstate syncs date");
  assert(page.includes('addEventListener("pagehide"'), "pagehide flush");
  assert(page.includes("visibilitychange"), "visibilitychange flush");
  assert(page.includes("decideDraftLeaveFlush"), "leave flush uses helper");
  assert(/keepalive:\s*false/.test(page.split("async function putAssignmentDraft")[1] || page), "draft PUT keepalive false");
  assert(
    /if \(hydratingDraftRef\.current\) return/.test(
      page.split("const queueDraftSave")[1]?.split("const applyUnavailablePanelRows")[0] || ""
    ),
    "queueDraftSave skips while hydrating"
  );
  const flushOnce = page.split("const flushOnce")[1]?.split("const flushDraftSave")[0] || "";
  assert(
    flushOnce.includes('res.status === 409') &&
      !/nextDraftVersionAfterConflict/.test(flushOnce) &&
      !/putAssignmentDraft\(\s*next/.test(flushOnce.split("409")[1] || ""),
    "flushOnce 409 does not retry"
  );
  assert(!/sendBeacon/.test(page), "no sendBeacon");
  assert(!/location\.href\s*=/.test(page), "no location.href assign");
  const dateFx = page.split('if (typeof window !== "undefined")')[1]?.split("if (draftSaveTimerRef")[0] || "";
  assert(
    /assignmentsDateFromSearch\(window\.location\.search\)/.test(dateFx) &&
      /setDate\(fromUrl\)/.test(dateFx),
    "empty date hydrates from URL before GET"
  );
}

section("hydrate race source");
{
  const page = readSrc("src/app/manage/assignments/page.tsx");
  const dateFx = page.split("dateRef.current = date;")[1]?.split("useEffect(() => {")[0] || "";
  const hydrateIdx = dateFx.indexOf("hydratingDraftRef.current = true");
  const getIdx = dateFx.indexOf("loadServerDraft(date)");
  const queueIdx = dateFx.indexOf("queueDraftSave(next)");
  assert(
    hydrateIdx >= 0 && getIdx > hydrateIdx,
    "date effect sets hydrating before GET"
  );
  assert(
    queueIdx < 0 || queueIdx > getIdx,
    "GET happens before any post-hydrate queueDraftSave"
  );
}

console.log(`\nDONE: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
