/**
 * Admin PWA /caddy bounce: role gate + post-login dest (DB 없음)
 * 실행: npm run test:role-routing-unit
 */
import fs from "node:fs";
import path from "node:path";
import {
  CADDY_ONLY_ALERT,
  isCaddyShellPath,
  resolveCaddyPageGate,
  resolvePostLoginHref,
} from "../src/lib/roleRouting";
import { safeReturnPath } from "../src/lib/safeReturnPath";
import { PWA_DISPLAY, PWA_START_URL } from "../src/lib/pwaManifest";
import manifest from "../src/app/manifest";

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

function read(rel: string) {
  return fs.readFileSync(path.resolve(rel), "utf8");
}

section("A authenticated caddy → /caddy enter");
{
  const gate = resolveCaddyPageGate("caddy");
  assert(gate.action === "enter", "caddy enters /caddy");
  assert(!("alert" in gate) || (gate as { alert?: boolean }).alert !== true, "caddy no deny alert");
}

section("B authenticated leader → /caddy enter");
{
  const gate = resolveCaddyPageGate("leader");
  assert(gate.action === "enter", "leader enters /caddy");
}

section("C authenticated admin → /caddy replace /manage, alert 0");
{
  const gate = resolveCaddyPageGate("admin");
  assert(gate.action === "replace", "admin replace, not enter");
  assert(gate.action === "replace" && gate.href === "/manage", "admin → /manage");
  assert(gate.action === "replace" && gate.alert === false, "admin alert 0");
  assert(gate.action !== "enter", "admin is not treated as caddy");
}

section("D unauth /caddy → login callbackUrl=/caddy");
{
  const layout = read("src/app/caddy/layout.tsx");
  const mw = read("src/middleware.ts");
  assert(layout.includes('redirect("/login?callbackUrl=/caddy")'), "layout unauth → login callback /caddy");
  assert(mw.includes('login.searchParams.set("callbackUrl", pathname)'), "middleware preserves pathname callback");
  assert(mw.includes('pathname.startsWith("/caddy")'), "middleware gates /caddy");
}

section("E admin login with callbackUrl=/caddy → /manage");
{
  assert(
    resolvePostLoginHref({ role: "admin", callbackUrl: "/caddy" }) === "/manage",
    "admin + /caddy callback → /manage"
  );
  assert(
    resolvePostLoginHref({ role: "admin", callbackUrl: "/caddy/link" }) === "/manage",
    "admin + /caddy/link callback → /manage"
  );
  assert(
    resolvePostLoginHref({ role: "admin", callbackUrl: "/caddy?from=pwa" }) === "/manage",
    "admin + /caddy query callback → /manage"
  );
  assert(
    resolvePostLoginHref({ role: "admin" }) === "/manage",
    "admin no callback → /manage"
  );
}

section("F caddy login with callbackUrl=/caddy → /caddy");
{
  assert(
    resolvePostLoginHref({ role: "caddy", callbackUrl: "/caddy" }) === "/caddy",
    "caddy keeps /caddy callback"
  );
  assert(resolvePostLoginHref({ role: "caddy" }) === "/caddy", "caddy default /caddy");
}

section("G leader login with callbackUrl=/caddy → /caddy");
{
  assert(
    resolvePostLoginHref({ role: "leader", callbackUrl: "/caddy" }) === "/caddy",
    "leader keeps /caddy callback"
  );
  assert(resolvePostLoginHref({ role: "leader" }) === "/caddy", "leader default /caddy");
}

section("H unsupported role fail-closed");
{
  for (const role of [null, undefined, "", "guest", "staff", "user"]) {
    const gate = resolveCaddyPageGate(role);
    assert(gate.action === "deny", `${String(role)} deny`);
    assert(gate.action === "deny" && gate.alert === true, `${String(role)} alert`);
    assert(
      gate.action === "deny" && gate.alertMessage === CADDY_ONLY_ALERT,
      `${String(role)} caddy-only alert`
    );
    assert(gate.action === "deny" && gate.href === "/login", `${String(role)} → /login`);
  }
}

section("I malicious / open-redirect callback rejected");
{
  const evil = [
    "https://evil.com",
    "http://evil.com",
    "//evil.com",
    "///evil.com",
    "/\\evil.com",
    "\\\\evil.com",
    "javascript:alert(1)",
    "https://verthill.example/caddy",
  ];
  for (const raw of evil) {
    assert(safeReturnPath(raw) === null, `safeReturnPath rejects ${JSON.stringify(raw)}`);
    assert(
      resolvePostLoginHref({ role: "admin", callbackUrl: raw }) === "/manage",
      `admin evil callback falls back /manage (${JSON.stringify(raw)})`
    );
    assert(
      resolvePostLoginHref({ role: "caddy", callbackUrl: raw }) === "/caddy",
      `caddy evil callback falls back /caddy (${JSON.stringify(raw)})`
    );
  }
  assert(safeReturnPath("/caddy") === "/caddy", "relative /caddy still allowed");
  assert(safeReturnPath("/manage/users") === "/manage/users", "nested relative still allowed");
  assert(safeReturnPath("/foo\n/bar") === null, "embedded newline still rejected");
  assert(safeReturnPath("/foo\r/bar") === null, "embedded CR still rejected");
  assert(
    resolvePostLoginHref({ role: "admin", callbackUrl: "/board" }) === "/board",
    "admin non-caddy safe callback still honored"
  );
  assert(
    resolvePostLoginHref({
      role: "admin",
      mustChangePassword: true,
      callbackUrl: "/caddy",
    }) === "/change-password",
    "mustChangePassword still wins over /caddy callback"
  );
}

section("caddy shell path helper");
{
  assert(isCaddyShellPath("/caddy") === true, "/caddy is shell");
  assert(isCaddyShellPath("/caddy/") === true, "/caddy/ is shell");
  assert(isCaddyShellPath("/caddy/link") === true, "/caddy/link is shell");
  assert(isCaddyShellPath("/caddy?x=1") === true, "/caddy query is shell");
  assert(isCaddyShellPath("/board") === false, "/board is not caddy shell");
  assert(isCaddyShellPath("/manage") === false, "/manage is not caddy shell");
  assert(isCaddyShellPath("/caddies") === false, "/caddies is not /caddy");
}

section("wiring: caddy page / login / kakao / manifest");
{
  const page = read("src/app/caddy/page.tsx");
  const login = read("src/app/login/LoginClient.tsx");
  const kakao = read("src/app/api/auth/kakao/callback/route.ts");
  const layout = read("src/app/caddy/layout.tsx");

  assert(page.includes("resolveCaddyPageGate"), "caddy page uses gate helper");
  assert(page.includes("router.replace(gate.href)"), "admin uses replace not push");
  assert(page.includes("loading || !allowed"), "admin never renders dashboard content");
  assert(
    !page.includes("d.role !== 'caddy' && d.role !== 'leader'"),
    "old all-non-caddy alert gate removed"
  );
  assert(!page.includes("캐디만 접근 가능합니다."), "page does not hardcode admin-alerting copy");

  assert(login.includes("resolvePostLoginHref"), "LoginClient uses post-login helper");
  assert(login.includes("safeReturnPath"), "LoginClient uses shared callback validation");
  assert(!login.includes("if (safeCallback)"), "LoginClient no longer prefers any callback over admin dest");

  assert(kakao.includes("resolvePostLoginHref"), "kakao callback uses post-login helper");
  assert(
    !kakao.includes('returnTo || (role === "admin" ? "/manage" : "/caddy")'),
    "kakao no longer prefers raw /caddy return for admin"
  );

  assert(layout.includes('auth.role !== "admin"'), "layout still allows admin through to client gate");
  assert(!layout.includes('redirect("/manage")'), "layout does not grant admin caddy content via manage redirect");

  const m = manifest();
  assert(PWA_START_URL === "/caddy", "constant start_url /caddy");
  assert(m.start_url === "/caddy", "manifest start_url /caddy");
  assert(m.display === PWA_DISPLAY, "manifest display unchanged");
  assert(m.start_url !== "/manage", "start_url is not /manage");
}

console.log(`\nDONE: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
