/**
 * Critical A1–A4: legacy assignments / schedule / dbcheck auth (production write 없음)
 * 실행: npm run test:legacy-api-auth-unit
 */
import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import {
  SESSION_COOKIE_NAME,
  buildSessionClaims,
  signSessionClaims,
} from "../src/lib/sessionCookies";
import { requireAdmin, requirePublishedReader } from "../src/lib/auth";
import {
  isAllowedAssignmentType,
  isValidDateRange,
  parseAssignmentYmd,
  parsePositiveInt,
} from "../src/lib/legacyAssignmentApi";
import { middleware } from "../src/middleware";
import { GET as assignmentsGET, POST as assignmentsPOST } from "../src/app/api/assignments/route";
import {
  PATCH as assignmentPATCH,
  DELETE as assignmentDELETE,
} from "../src/app/api/assignments/[id]/route";
import { GET as scheduleGET, POST as schedulePOST } from "../src/app/api/schedule/route";
import { GET as scheduleTableGET } from "../src/app/api/schedule/table/route";
import { POST as scheduleGeneratePOST } from "../src/app/api/schedule/generate/route";
import { GET as dbcheckGET } from "../src/app/api/dbcheck/route";

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

async function cookieReq(
  role: "admin" | "caddy" | "leader",
  url: string,
  init?: RequestInit
) {
  const token = await signSessionClaims(
    buildSessionClaims({
      userId: null,
      username: role,
      role,
      sessionVersion: 0,
    })
  );
  return new NextRequest(url, {
    ...init,
    headers: {
      cookie: `${SESSION_COOKIE_NAME}=${token}`,
      ...(init?.headers || {}),
    },
  });
}

async function jsonStatus(res: Response): Promise<{ status: number; body: unknown }> {
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function main() {
  process.env.SESSION_SECRET =
    process.env.SESSION_SECRET || "unit-test-session-secret-32chars!!";

  section("validation helpers");
  {
    assert(isAllowedAssignmentType("OFF"), "OFF allowed");
    assert(isAllowedAssignmentType("FAMILY_EVENT"), "FAMILY_EVENT allowed");
    assert(!isAllowedAssignmentType("HACK"), "unknown type rejected");
    assert(!isAllowedAssignmentType(""), "empty type rejected");
    assert(parsePositiveInt(3) === 3, "int caddyId");
    assert(parsePositiveInt("12") === 12, "string caddyId");
    assert(parsePositiveInt("0") === null, "0 rejected");
    assert(parsePositiveInt("-1") === null, "negative rejected");
    assert(parsePositiveInt("1.5") === null, "float rejected");
    assert(parseAssignmentYmd("2026-09-29")?.ymd === "2026-09-29", "valid ymd");
    assert(parseAssignmentYmd("2026-02-31") === null, "impossible date rejected");
    assert(parseAssignmentYmd("not-a-date") === null, "garbage date rejected");
    const a = parseAssignmentYmd("2026-09-01")!.date;
    const b = parseAssignmentYmd("2026-08-01")!.date;
    assert(isValidDateRange(b, a), "end after start ok");
    assert(!isValidDateRange(a, b), "end before start rejected");
  }

  section("source: A1 assignments admin + validation");
  {
    const list = read("src/app/api/assignments/route.ts");
    const one = read("src/app/api/assignments/[id]/route.ts");
    const pub = read("src/app/api/assignments/published/route.ts");
    const draft = read("src/app/api/assignments/draft/route.ts");
    const page = read("src/app/assignments/page.tsx");
    assert(/requireAdmin/.test(list), "GET/POST assignments requireAdmin");
    assert(/isAllowedAssignmentType/.test(list), "POST type allowlist");
    assert(/isValidDateRange/.test(list), "POST date range");
    assert(/존재하지 않는 캐디/.test(list), "POST missing caddy 404");
    assert(/requireAdmin/.test(one), "PATCH/DELETE requireAdmin");
    assert(/isAllowedAssignmentType/.test(one), "PATCH type allowlist");
    assert(/존재하지 않는 일정/.test(one), "PATCH/DELETE missing 404");
    assert(/requirePublishedReader/.test(pub), "published GET still published-reader");
    assert(/requireAdmin/.test(draft), "draft still admin");
    assert(/fetch\('\/api\/assignments'\)/.test(page), "legacy page still uses assignments API");
    assert(
      !/fetch\(['"]\/api\/assignments/.test(read("src/app/manage/assignments/page.tsx")) ||
        /\/api\/assignments\/(draft|published|preview|confirm|reflow)/.test(
          read("src/app/manage/assignments/page.tsx")
        ),
      "manage board keeps modern assignment APIs"
    );
  }

  section("source: A2 schedule read vs write");
  {
    const schedule = read("src/app/api/schedule/route.ts");
    const table = read("src/app/api/schedule/table/route.ts");
    const gen = read("src/app/api/schedule/generate/route.ts");
    const schedPage = read("src/app/schedule/page.tsx");
    const board = read("src/app/board/page.tsx");
    const getFn = schedule.split("export async function POST")[0] || "";
    const postFn = schedule.split("export async function POST")[1] || "";
    assert(/requirePublishedReader/.test(getFn), "GET /api/schedule published-reader");
    assert(/requireAdmin/.test(postFn), "POST /api/schedule admin");
    assert(!/requirePublishedReader/.test(postFn), "POST schedule is not caddy-writable");
    assert(/requirePublishedReader/.test(table), "GET table published-reader");
    assert(/requireAdmin/.test(gen), "POST generate admin");
    assert(/\/api\/schedule\/table/.test(schedPage), "가용표 page still uses table API");
    assert(/\/api\/assignments\/published/.test(board), "caddy board still published API");
    assert(!/phoneNormalized:\s*true/.test(schedule), "schedule GET omits phone");
    assert(!/memo:\s*true/.test(getFn), "schedule GET omits memo");
    assert(!/extraFlags:\s*true/.test(getFn), "schedule GET omits extraFlags");
  }

  section("source: A3 middleware + A4 dbcheck");
  {
    const mw = read("src/middleware.ts");
    const dbcheck = read("src/app/api/dbcheck/route.ts");
    const health = read("src/app/api/health/route.ts");
    const shell = read("src/components/manage/ManageShell.tsx");
    assert(/\/assignments/.test(mw), "middleware matcher includes /assignments");
    assert(/\/schedule/.test(mw), "middleware matcher includes /schedule");
    assert(/pathname === "\/assignments"/.test(mw), "assignments admin gate");
    assert(/pathname === "\/schedule"/.test(mw), "schedule published-reader gate");
    assert(/href: "\/schedule"/.test(shell), "admin ManageShell still links 가용표");
    assert(/requireAdmin/.test(dbcheck), "dbcheck admin only");
    assert(/CourseReportPhoto/.test(dbcheck), "dbcheck still probes photo table for admin");
    assert(/ok:\s*true/.test(health), "public health remains /api/health");
    assert(!/requireAdmin/.test(health), "health stays public");
  }

  section("guards: unauth / caddy / admin");
  {
    const unauthPub = await requirePublishedReader(
      new NextRequest("http://localhost/api/schedule/table?date=2026-09-29")
    );
    assert(unauthPub instanceof Response && unauthPub.status === 401, "unauth published-reader 401");
    const unauthAdmin = await requireAdmin(
      new NextRequest("http://localhost/api/assignments")
    );
    assert(unauthAdmin instanceof Response && unauthAdmin.status === 401, "unauth requireAdmin 401");

    const caddyRead = await requirePublishedReader(
      await cookieReq("caddy", "http://localhost/api/schedule/table?date=2026-09-29")
    );
    assert(caddyRead === undefined, "caddy published-reader passes");
    const leaderRead = await requirePublishedReader(
      await cookieReq("leader", "http://localhost/api/schedule?date=2026-09-29")
    );
    assert(leaderRead === undefined, "leader published-reader passes");
    const caddyWrite = await requireAdmin(
      await cookieReq("caddy", "http://localhost/api/assignments")
    );
    assert(caddyWrite instanceof Response && caddyWrite.status === 401, "caddy requireAdmin 401");
    const adminOk = await requireAdmin(
      await cookieReq("admin", "http://localhost/api/assignments")
    );
    assert(adminOk === undefined, "admin requireAdmin passes");
  }

  section("handlers: unauth blocked (no write)");
  {
    const getA = await jsonStatus(
      await assignmentsGET(new NextRequest("http://localhost/api/assignments?caddyId=1"))
    );
    assert(getA.status === 401, `GET /api/assignments unauth ${getA.status}`);

    const postA = await jsonStatus(
      await assignmentsPOST(
        new NextRequest("http://localhost/api/assignments", {
          method: "POST",
          body: JSON.stringify({
            caddyId: 1,
            type: "OFF",
            startDate: "2026-09-01",
            endDate: "2026-09-02",
          }),
        })
      )
    );
    assert(postA.status === 401, `POST /api/assignments unauth ${postA.status}`);

    const patchA = await jsonStatus(
      await assignmentPATCH(
        new NextRequest("http://localhost/api/assignments/1", {
          method: "PATCH",
          body: JSON.stringify({ type: "SICK" }),
        }),
        { params: { id: "1" } }
      )
    );
    assert(patchA.status === 401, `PATCH /api/assignments/1 unauth ${patchA.status}`);

    const delA = await jsonStatus(
      await assignmentDELETE(
        new NextRequest("http://localhost/api/assignments/1", { method: "DELETE" }),
        { params: { id: "1" } }
      )
    );
    assert(delA.status === 401, `DELETE /api/assignments/1 unauth ${delA.status}`);

    const table = await jsonStatus(
      await scheduleTableGET(
        new NextRequest("http://localhost/api/schedule/table?date=2026-09-29")
      )
    );
    assert(table.status === 401, `GET schedule/table unauth ${table.status}`);
    assert(
      !table.body ||
        typeof table.body !== "object" ||
        !("columns" in (table.body as object)),
      "unauth table has no roster columns"
    );

    const schedGet = await jsonStatus(
      await scheduleGET(new NextRequest("http://localhost/api/schedule?date=2026-09-29"))
    );
    assert(schedGet.status === 401, `GET /api/schedule unauth ${schedGet.status}`);

    const schedPost = await jsonStatus(
      await schedulePOST(
        new NextRequest("http://localhost/api/schedule", {
          method: "POST",
          body: JSON.stringify({ date: "2026-09-29" }),
        })
      )
    );
    assert(schedPost.status === 401, `POST /api/schedule unauth ${schedPost.status}`);

    const gen = await jsonStatus(
      await scheduleGeneratePOST(
        new NextRequest("http://localhost/api/schedule/generate", { method: "POST" })
      )
    );
    assert(gen.status === 401, `POST schedule/generate unauth ${gen.status}`);

    const dbc = await jsonStatus(
      await dbcheckGET(new NextRequest("http://localhost/api/dbcheck"))
    );
    assert(dbc.status === 401, `GET /api/dbcheck unauth ${dbc.status}`);
    assert(
      !dbc.body ||
        typeof dbc.body !== "object" ||
        !("count" in (dbc.body as object)),
      "unauth dbcheck has no count"
    );
  }

  section("handlers: caddy cannot write / cannot read assignments");
  {
    const caddyGetA = await jsonStatus(
      await assignmentsGET(
        await cookieReq("caddy", "http://localhost/api/assignments?caddyId=1")
      )
    );
    assert(caddyGetA.status === 401, `caddy GET assignments ${caddyGetA.status}`);

    const caddyPost = await jsonStatus(
      await assignmentsPOST(
        await cookieReq("caddy", "http://localhost/api/assignments", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            caddyId: 1,
            type: "OFF",
            startDate: "2026-09-01",
            endDate: "2026-09-02",
          }),
        })
      )
    );
    assert(caddyPost.status === 401, `caddy POST assignments ${caddyPost.status}`);

    const caddyPatch = await jsonStatus(
      await assignmentPATCH(
        await cookieReq("caddy", "http://localhost/api/assignments/1", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "SICK" }),
        }),
        { params: { id: "1" } }
      )
    );
    assert(caddyPatch.status === 401, `caddy PATCH assignment ${caddyPatch.status}`);

    const caddyDel = await jsonStatus(
      await assignmentDELETE(
        await cookieReq("caddy", "http://localhost/api/assignments/1", {
          method: "DELETE",
        }),
        { params: { id: "1" } }
      )
    );
    assert(caddyDel.status === 401, `caddy DELETE assignment ${caddyDel.status}`);

    const caddySchedPost = await jsonStatus(
      await schedulePOST(
        await cookieReq("caddy", "http://localhost/api/schedule", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ date: "2026-09-29" }),
        })
      )
    );
    assert(caddySchedPost.status === 401, `caddy POST schedule ${caddySchedPost.status}`);

    const caddyGen = await jsonStatus(
      await scheduleGeneratePOST(
        await cookieReq("caddy", "http://localhost/api/schedule/generate", {
          method: "POST",
        })
      )
    );
    assert(caddyGen.status === 401, `caddy POST generate ${caddyGen.status}`);

    const caddyDb = await jsonStatus(
      await dbcheckGET(await cookieReq("caddy", "http://localhost/api/dbcheck"))
    );
    assert(caddyDb.status === 401, `caddy GET dbcheck ${caddyDb.status}`);
  }

  section("handlers: admin validation (no successful write)");
  {
    const badType = await jsonStatus(
      await assignmentsPOST(
        await cookieReq("admin", "http://localhost/api/assignments", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            caddyId: 1,
            type: "HACK",
            startDate: "2026-09-01",
            endDate: "2026-09-02",
          }),
        })
      )
    );
    assert(badType.status === 400, `admin POST bad type ${badType.status}`);

    const badRange = await jsonStatus(
      await assignmentsPOST(
        await cookieReq("admin", "http://localhost/api/assignments", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            caddyId: 1,
            type: "OFF",
            startDate: "2026-09-10",
            endDate: "2026-09-01",
          }),
        })
      )
    );
    assert(badRange.status === 400, `admin POST bad range ${badRange.status}`);

    const missingCaddy = await jsonStatus(
      await assignmentsPOST(
        await cookieReq("admin", "http://localhost/api/assignments", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            caddyId: 999999999,
            type: "OFF",
            startDate: "2026-09-01",
            endDate: "2026-09-02",
          }),
        })
      )
    );
    assert(
      missingCaddy.status === 404,
      `admin POST missing caddy ${missingCaddy.status}`
    );

    const adminGet = await jsonStatus(
      await assignmentsGET(await cookieReq("admin", "http://localhost/api/assignments"))
    );
    assert(adminGet.status === 200, `admin GET assignments ${adminGet.status}`);
    assert(Array.isArray(adminGet.body), "admin GET assignments returns array");

    const adminTable = await jsonStatus(
      await scheduleTableGET(
        await cookieReq("admin", "http://localhost/api/schedule/table?date=2026-09-29")
      )
    );
    assert(adminTable.status === 200, `admin GET table ${adminTable.status}`);
    assert(
      adminTable.body &&
        typeof adminTable.body === "object" &&
        "columns" in (adminTable.body as object),
      "admin table has columns"
    );

    const caddyTable = await jsonStatus(
      await scheduleTableGET(
        await cookieReq("caddy", "http://localhost/api/schedule/table?date=2026-09-29")
      )
    );
    assert(caddyTable.status === 200, `caddy GET table ${caddyTable.status}`);

    const adminDb = await jsonStatus(
      await dbcheckGET(await cookieReq("admin", "http://localhost/api/dbcheck"))
    );
    assert(adminDb.status === 200, `admin GET dbcheck ${adminDb.status}`);
    assert(
      adminDb.body &&
        typeof adminDb.body === "object" &&
        "connected" in (adminDb.body as object),
      "admin dbcheck still returns diagnostic"
    );
  }

  section("middleware: /assignments admin / /schedule published-reader");
  {
    const unauthA = await middleware(
      new NextRequest("https://example.com/assignments")
    );
    assert(unauthA.status === 307 || unauthA.status === 302, "unauth /assignments redirect");
    assert(
      (unauthA.headers.get("location") || "").includes("/login"),
      "unauth /assignments → login"
    );

    const unauthS = await middleware(
      new NextRequest("https://example.com/schedule")
    );
    assert(unauthS.status === 307 || unauthS.status === 302, "unauth /schedule redirect");
    assert(
      (unauthS.headers.get("location") || "").includes("/login"),
      "unauth /schedule → login"
    );

    const caddyA = await middleware(
      await cookieReq("caddy", "https://example.com/assignments")
    );
    assert(caddyA.status === 307 || caddyA.status === 302, "caddy /assignments redirect");

    const caddyS = await middleware(
      await cookieReq("caddy", "https://example.com/schedule")
    );
    assert(caddyS.status === 200 || caddyS.status === 0, `caddy /schedule next ${caddyS.status}`);
    assert(
      !(caddyS.headers.get("location") || "").includes("/login"),
      "caddy /schedule not sent to login"
    );

    const adminA = await middleware(
      await cookieReq("admin", "https://example.com/assignments")
    );
    assert(
      !(adminA.headers.get("location") || "").includes("/login"),
      "admin /assignments allowed"
    );
    const adminS = await middleware(
      await cookieReq("admin", "https://example.com/schedule")
    );
    assert(
      !(adminS.headers.get("location") || "").includes("/login"),
      "admin /schedule allowed"
    );
  }

  console.log(`\nDONE: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
