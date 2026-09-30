/**
 * /admin/login leftover page: redirect to /login. No new auth surface.
 * 실행: npm run test:admin-login-page-unit
 */
import fs from "node:fs";
import path from "node:path";

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

function exists(rel: string) {
  return fs.existsSync(path.resolve(rel));
}

section("source: /admin/login is a fixed /login redirect");
{
  const page = read("src/app/admin/login/page.tsx");
  assert(page.includes('redirect("/login")'), "page redirects to /login");
  assert(!page.includes("_LoginClient"), "page does not import leftover client");
  assert(!page.includes("/api/auth"), "page does not post to /api/auth");
  assert(!page.includes("/api/admin"), "page does not add a second admin auth UI");
  assert(!page.includes("searchParams"), "page does not forward query (open redirect)");
  assert(!page.includes("callbackUrl"), "page does not take callbackUrl");
  assert(!exists("src/app/admin/login/_LoginClient.tsx"), "_LoginClient.tsx removed");
  assert(!exists("src/app/api/auth/route.ts"), "no new /api/auth route");
}

section("source: production login + admin APIs + Kakao unchanged");
{
  const loginPage = read("src/app/login/page.tsx");
  const loginClient = read("src/app/login/LoginClient.tsx");
  const apiLogin = read("src/app/api/login/route.ts");
  const admin = read("src/app/api/admin/route.ts");
  const adminLogin = read("src/app/api/admin/login/route.ts");
  const nextauth = read("src/app/api/auth/[...nextauth]/route.ts");
  const kakao = read("src/app/api/auth/kakao/callback/route.ts");
  const mw = read("src/middleware.ts");

  assert(loginPage.includes('if (auth?.role === "admin") redirect("/manage")'), "logged-in admin /login → /manage");
  assert(!loginPage.includes("/admin/login"), "/login does not bounce back to /admin/login");
  assert(loginClient.includes('fetch("/api/login"'), "/login still posts /api/login");
  assert(loginClient.includes("runKakaoLogin"), "Kakao button still on /login");
  assert(apiLogin.includes("claimPasswordLoginAttempt"), "/api/login still C7 claim-first");
  assert(admin.includes("postAdminEnvPasswordLogin"), "/api/admin helper kept");
  assert(adminLogin.includes("postAdminEnvPasswordLogin"), "/api/admin/login helper kept");
  assert(nextauth.includes("authorizePasswordCredentials"), "NextAuth helper kept");
  assert(kakao.includes("findOrCreateKakaoSessionUser"), "Kakao callback untouched");
  assert(!mw.includes('"/admin/login"'), "middleware does not special-case /admin/login");
}

section("runtime: page throws NEXT_REDIRECT /login");
{
  const { default: AdminLoginPage } = await import("../src/app/admin/login/page");
  let thrown: unknown = null;
  try {
    AdminLoginPage();
  } catch (e) {
    thrown = e;
  }
  const digest = String((thrown as { digest?: string } | null)?.digest ?? "");
  const msg = String((thrown as { message?: string } | null)?.message ?? thrown ?? "");
  assert(thrown != null, "redirect throws");
  assert(
    digest.includes("NEXT_REDIRECT") || msg.includes("NEXT_REDIRECT"),
    "Next.js redirect error"
  );
  assert(
    digest.includes("/login") || msg.includes("/login"),
    "redirect target is /login"
  );
  assert(!digest.includes("http://") && !digest.includes("https://"), "no absolute URL redirect");
}

console.log(`\nDONE: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
