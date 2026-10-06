/**
 * 대시보드 캐디 현황 / 가용표 탭 통합
 *   npm run test:admin-ops-workspace-unit
 */
import fs from "node:fs";
import path from "node:path";
import {
  OPS_WORKSPACE_AVAILABILITY_PATH,
  OPS_WORKSPACE_STATUS_PATH,
  availabilityStandaloneHref,
  opsWorkspaceHref,
  parseOpsWorkspaceDate,
  parseOpsWorkspaceView,
} from "../src/lib/adminOpsWorkspace";

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

console.log("== view / date URL ==");
assert(parseOpsWorkspaceView(null) === "status", "default status");
assert(parseOpsWorkspaceView("status") === "status", "explicit status");
assert(parseOpsWorkspaceView("availability") === "availability", "availability");
assert(parseOpsWorkspaceView("other") === "status", "unknown falls back to status");
assert(parseOpsWorkspaceDate("2026-10-06") === "2026-10-06", "valid date");
assert(parseOpsWorkspaceDate("nope") === null, "invalid date");
assert(parseOpsWorkspaceDate(null) === null, "missing date");
assert(
  opsWorkspaceHref("status") === "/manage?view=status",
  "status href"
);
assert(
  opsWorkspaceHref("availability") === "/manage?view=availability",
  "availability href"
);
assert(
  opsWorkspaceHref("availability", "2026-10-06") ===
    "/manage?view=availability&date=2026-10-06",
  "availability keeps date"
);
assert(
  opsWorkspaceHref("status", "2026-10-06") === "/manage?view=status&date=2026-10-06",
  "status keeps date"
);
assert(
  availabilityStandaloneHref("2026-10-06") ===
    "/manage/availability?date=2026-10-06",
  "standalone date query"
);
assert(
  availabilityStandaloneHref(null) === OPS_WORKSPACE_AVAILABILITY_PATH,
  "standalone without date"
);
assert(OPS_WORKSPACE_STATUS_PATH === "/manage", "status path");

console.log("== lazy mount / no duplicated fetch ==");
{
  const workspace = read("src/components/manage/ManageOpsWorkspace.tsx");
  const dash = read("src/components/manage/AdminOpsDashboard.tsx");
  const panel = read("src/components/manage/ManageAvailabilityPanel.tsx");
  const page = read("src/app/manage/page.tsx");
  const avPage = read("src/app/manage/availability/page.tsx");
  assert(workspace.includes('view === "status"'), "status tab mounts dashboard");
  assert(
    workspace.includes("ManageAvailabilityPanel") &&
      workspace.includes('view === "availability"'),
    "availability tab mounts panel"
  );
  assert(workspace.includes("dynamic("), "availability panel is lazy");
  assert(
    workspace.includes("캐디 현황") && workspace.includes("가용표"),
    "tab labels"
  );
  assert(page.includes("ManageOpsWorkspace"), "manage page uses workspace");
  assert(!page.includes("AdminOpsDashboard"), "page does not mount dashboard eagerly");
  assert(
    !dash.includes("/api/availability"),
    "status dashboard does not call availability API"
  );
  assert(
    !panel.includes("account-link-summary"),
    "availability panel does not fetch account summary"
  );
  assert(
    panel.includes("/api/availability?date="),
    "availability still uses existing GET"
  );
  assert(
    panel.includes("가용 계산") && panel.includes("고정 슬롯 그리드"),
    "availability UI reused"
  );
  assert(
    avPage.includes("ManageAvailabilityPanel") && !avPage.includes("redirect("),
    "standalone route kept"
  );
  assert(
    !/for \(const .+ of .+\.caddies[\s\S]*fetch\(/.test(dash),
    "no per-caddy fetch on dashboard"
  );
}

console.log("== no calc / engine / schema edits ==");
{
  const engine = read("src/lib/availabilityEngine.ts");
  const service = read("src/lib/availabilityService.ts");
  assert(engine.includes("export type AvailabilityResult"), "engine file still present");
  assert(service.includes("loadAvailabilityForDate"), "availability service reused");
  const panel = read("src/components/manage/ManageAvailabilityPanel.tsx");
  assert(panel.includes("formatCaddyLabel"), "panel keeps display helper");
  assert(!panel.includes("autoAssignEngine"), "no auto-assign in panel");
}

if (failed > 0) {
  console.error(`\nFAIL ${failed} (passed ${passed})`);
  process.exit(1);
}
console.log(`\nOK ${passed}`);
