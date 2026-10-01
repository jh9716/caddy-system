/**
 * Assignments date-bundle (Performance PR B)
 * DB/Sheet 없이 가드·배선만 검증.
 *   npm run test:assignments-date-bundle-unit
 */
import fs from "node:fs";
import path from "node:path";
import {
  dateBundleSectionWarnings,
  shouldApplyAssignmentsDateBundle,
} from "../src/lib/assignmentsDateBundleView";
import { publishedMetadataFromRecord } from "../src/lib/assignmentsDateBundle";
import type { DailyBoardPublishedRecord } from "../src/lib/dailyBoardPublishedService";

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

section("date race / loadGen");
{
  assert(
    shouldApplyAssignmentsDateBundle({
      requestGen: 2,
      latestGen: 2,
      payloadDate: "2026-10-02",
      selectedDate: "2026-10-02",
    }),
    "current gen + matching date applies"
  );
  assert(
    !shouldApplyAssignmentsDateBundle({
      requestGen: 1,
      latestGen: 2,
      payloadDate: "2026-10-01",
      selectedDate: "2026-10-02",
    }),
    "stale gen ignored even if caller forgets date"
  );
  assert(
    !shouldApplyAssignmentsDateBundle({
      requestGen: 2,
      latestGen: 2,
      payloadDate: "2026-10-01",
      selectedDate: "2026-10-02",
    }),
    "late 10/1 payload cannot overwrite 10/2"
  );
  assert(
    !shouldApplyAssignmentsDateBundle({
      requestGen: 2,
      latestGen: 2,
      payloadDate: "2026-10-02",
      selectedDate: "2026-10-02",
      cancelled: true,
    }),
    "cancelled effect ignored"
  );
}

section("optional section warnings");
{
  const lines = dateBundleSectionWarnings({
    draft: { error: "작업본 조회 실패" },
    boardPreview: { error: "미리보기 실패" },
    specialDuties: { error: "특수근무 처리 실패" },
  });
  assert(!lines.some((line) => line.includes("작업본")), "draft error is critical, not a warning line");
  assert(lines.some((line) => line.includes("배치표 알림")), "preview warning labeled");
  assert(lines.some((line) => line.includes("특수근무")), "special duty warning labeled");
}

section("published metadata only");
{
  const meta = publishedMetadataFromRecord({
    date: "2026-10-01",
    schemaVersion: 1,
    sourceDraftVersion: 4,
    payload: {
      schemaVersion: 1,
      date: "2026-10-01",
      openCourses: [],
      placements: [],
      sparesByShift: [],
      publisherUsername: "admin1",
    },
    publishedAt: "2026-10-01T00:00:00.000Z",
    publishedByUserId: 1,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  } as DailyBoardPublishedRecord);
  assert(meta?.sourceDraftVersion === 4, "keeps sourceDraftVersion");
  assert(meta?.publishedByUsername === "admin1", "keeps publisher username");
  assert(meta && !("payload" in meta), "does not expose published board payload");
  assert(publishedMetadataFromRecord(null) === null, "null published stays null");
}

section("route: in-process aggregate + strongest auth");
{
  const route = read("src/app/api/assignments/date-bundle/route.ts");
  assert(/requireAdmin/.test(route), "bundle uses requireAdmin");
  assert(/loadAssignmentsDateBundle/.test(route), "calls shared service");
  assert(!/fetch\(/.test(route), "route does not HTTP-chain other APIs");
  assert(!/requirePublishedReader/.test(route), "not weaker published-reader auth");
}

section("service: reuse + parallel + partial failure");
{
  const svc = read("src/lib/assignmentsDateBundle.ts");
  assert(/createAssignmentsDateReadContext/.test(svc), "request-scoped context");
  assert(/listCaddies/.test(svc) && /listOffOverrides/.test(svc), "shares caddies/overrides");
  assert(/listUnavailablePanelRows/.test(svc), "shares unavailables");
  assert(/Promise\.all/.test(svc), "independent reads in parallel");
  assert(/errors\.availability/.test(svc), "availability is section-level");
  assert(/errors\.boardPreview/.test(svc), "preview is section-level");
  assert(/throw draftResult\.error/.test(svc), "draft failure is critical");
  assert(!/fetch\(`\/api\//.test(svc), "service does not HTTP-chain routes");
  assert(/previewBoardPush\(prisma, ymd, \{/.test(svc), "preview reuses published/draft");
}

section("availability preload hooks stay optional");
{
  const avail = read("src/lib/availabilityService.ts");
  assert(/listCaddies\?:/.test(avail), "optional caddies reuse");
  assert(/listOffOverrides\?:/.test(avail), "optional override reuse");
  assert(/listUnavailables\?:/.test(avail), "optional unavailable reuse");
  assert(/fetchPublishedOffSheets/.test(avail), "OFF sheet path unchanged");
}

section("client date load is one bundle GET");
{
  const page = read("src/app/manage/assignments/page.tsx");
  assert(/\/api\/assignments\/date-bundle/.test(page), "page fetches date-bundle");
  assert(/shouldApplyAssignmentsDateBundle/.test(page), "date/loadGen guard");
  assert(/loadGen/.test(page), "assignments loadGen");
  assert(
    !/fetch\(`\/api\/availability\?date=/.test(page.split("async function refreshOpsDutyPanel")[0] || ""),
    "date-change path has no availability GET"
  );
  const dateEffect = page.slice(
    page.indexOf("const gen = ++loadGen.current"),
    page.indexOf("useEffect(() => {\n    const onPopState")
  );
  assert(/date-bundle/.test(dateEffect), "date effect uses bundle");
  assert(!/\/api\/availability\?/.test(dateEffect), "date effect has no availability GET");
  assert(!/\/api\/daily-ops-duties\?/.test(dateEffect), "date effect has no ops GET");
  assert(!/\/api\/daily-off-overrides\?/.test(dateEffect), "date effect has no override GET");
  assert(!/\/api\/daily-unavailables\?/.test(dateEffect), "date effect has no unavailable GET");
  assert(!/\/api\/third-weekly-start\?/.test(dateEffect), "date effect has no third-weekly GET");
  assert(!/\/api\/assignments\/published\?/.test(dateEffect), "date effect has no published GET");
  assert(!/off-sheet\/prewarm/.test(dateEffect), "date effect has no delayed prewarm GET");
  assert(/\/api\/assignments\/draft/.test(page), "draft mutation/reload endpoint kept");
  assert(/\/api\/assignments\/published/.test(page), "publish POST kept");
  assert(/clientResourceCache/.test(page) === false, "no assignments SWR cache");
}

section("child panels consume bundle on date load");
{
  const duty = read("src/app/manage/assignments/SpecialDutyPanel.tsx");
  const support = read("src/app/manage/assignments/SpecialSupportPanel.tsx");
  const push = read("src/components/manage/BoardPushNotifyCard.tsx");
  assert(/bundleReady/.test(duty) && /initialPayload/.test(duty), "special duty accepts bundle");
  assert(/bundleReady/.test(support) && /initialPayload/.test(support), "special support accepts bundle");
  assert(/bundleReady/.test(push) && /initialPreview/.test(push), "push card accepts bundle");
  assert(/\/api\/daily-special-duties/.test(duty), "special duty mutation reload kept");
  assert(/\/api\/daily-special-supports/.test(support), "special support mutation kept");
  assert(/\/api\/push\/board-preview/.test(push), "push refresh after send kept");
}

section("existing source endpoints remain");
{
  assert(fs.existsSync(path.resolve("src/app/api/availability/route.ts")), "availability route kept");
  assert(fs.existsSync(path.resolve("src/app/api/assignments/draft/route.ts")), "draft route kept");
  assert(fs.existsSync(path.resolve("src/app/api/daily-ops-duties/route.ts")), "ops route kept");
  assert(fs.existsSync(path.resolve("src/app/api/push/board-preview/route.ts")), "preview route kept");
}

if (failed > 0) {
  console.error(`\nassignments-date-bundle failed: ${failed} (passed ${passed})`);
  process.exit(1);
}
console.log(`\nassignments-date-bundle passed: ${passed}`);
