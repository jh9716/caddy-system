/**
 * Chromium: pagehide leave-save reliability.
 * keepalive:false must reach the server on reload and tab close,
 * including bodies > 64 KiB. keepalive:true above 64 KiB must not.
 *
 * 실행: npm run test:draft-leave-flush-chromium
 */
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const APP_PORT = 8796;
const DEBUG_PORT = 9336;
const LIMIT = 64 * 1024;
const LARGE = 70 * 1024;
const SMALL = 2048;

if (process.env.DATABASE_URL && !String(process.env.DATABASE_URL).includes("caddy_local")) {
  throw new Error("this test must not use a non-local DATABASE_URL");
}

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

type Arrival = { label: string; bytes: number; ka: string };
type Report = { label: string; arrivals: Arrival[]; checkpoint: boolean };

function send(res: ServerResponse, status: number, body: string, type: string) {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function chromeBin() {
  return (
    process.env.CHROME_BIN ||
    [
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium-browser",
      "/usr/bin/chromium",
    ].find((bin) => existsSync(bin))
  );
}

function reloadHtml(label: string, keepalive: boolean, bytes: number) {
  return `<!doctype html>
<meta charset="utf-8" />
<title>draft leave flush ${label}</title>
<pre id="out">running</pre>
<script>
const LABEL = ${JSON.stringify(label)};
const KEEPALIVE = ${keepalive ? "true" : "false"};
const BYTES = ${bytes};
function pad(n) {
  const need = Math.max(0, n - 24);
  return JSON.stringify({ label: LABEL, pad: "x".repeat(need) }).slice(0, n);
}
async function report() {
  const arrivals = await fetch("/arrivals").then((r) => r.json()).catch(() => []);
  const body = {
    label: LABEL,
    arrivals,
    checkpoint: !!localStorage.getItem("c4.leave.ck." + LABEL),
  };
  document.getElementById("out").textContent = JSON.stringify(body);
  await fetch("/report", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
(async () => {
  if (sessionStorage.getItem("c4.leave.after." + LABEL) === "1") {
    await new Promise((r) => setTimeout(r, 700));
    await report();
    return;
  }
  sessionStorage.setItem("c4.leave.after." + LABEL, "1");
  const body = pad(BYTES);
  window.addEventListener("pagehide", () => {
    localStorage.setItem("c4.leave.ck." + LABEL, String(Date.now()));
    fetch("/save?label=" + encodeURIComponent(LABEL) + "&ka=" + String(KEEPALIVE), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: KEEPALIVE,
    }).catch(() => {});
  });
  await new Promise((r) => setTimeout(r, 120));
  location.reload();
})().catch((e) => {
  fetch("/report", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label: LABEL, arrivals: [], checkpoint: false, error: String(e) }),
  });
});
</script>`;
}

function tabCloseHtml(label: string, keepalive: boolean, bytes: number) {
  return `<!doctype html>
<meta charset="utf-8" />
<title>tabclose ${label}</title>
<script>
const LABEL = ${JSON.stringify(label)};
const KEEPALIVE = ${keepalive ? "true" : "false"};
const body = JSON.stringify({
  label: LABEL,
  pad: "x".repeat(Math.max(0, ${bytes} - 40)),
}).slice(0, ${bytes});
window.addEventListener("pagehide", () => {
  fetch("/save?label=" + encodeURIComponent(LABEL) + "&ka=" + String(KEEPALIVE), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    keepalive: KEEPALIVE,
  }).catch(() => {});
});
fetch("/ready?label=" + encodeURIComponent(LABEL), { method: "POST", body: "1" });
</script>`;
}

async function main() {
  const bin = chromeBin();
  if (!bin) throw new Error("headed Chromium not found");

  const state = {
    arrivals: [] as Arrival[],
    report: null as Report | null,
    ready: [] as string[],
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://127.0.0.1:${APP_PORT}`);
    if (req.method === "GET" && url.pathname === "/") {
      const label = url.searchParams.get("label") || "x";
      const ka = url.searchParams.get("ka") === "true";
      const bytes = Number(url.searchParams.get("bytes") || SMALL);
      const mode = url.searchParams.get("mode") || "reload";
      send(
        res,
        200,
        mode === "tabclose" ? tabCloseHtml(label, ka, bytes) : reloadHtml(label, ka, bytes),
        "text/html; charset=utf-8"
      );
      return;
    }
    if (req.method === "GET" && url.pathname === "/arrivals") {
      send(res, 200, JSON.stringify(state.arrivals), "application/json");
      return;
    }
    const buf = await readBody(req);
    if (url.pathname === "/save") {
      state.arrivals.push({
        label: url.searchParams.get("label") || "",
        bytes: buf.length,
        ka: url.searchParams.get("ka") || "",
      });
      send(res, 200, JSON.stringify({ ok: true, receivedBytes: buf.length }), "application/json");
      return;
    }
    if (url.pathname === "/ready") {
      state.ready.push(url.searchParams.get("label") || "");
      send(res, 200, '{"ok":true}', "application/json");
      return;
    }
    if (url.pathname === "/report") {
      state.report = JSON.parse(buf.toString("utf8")) as Report;
      send(res, 200, '{"ok":true}', "application/json");
      return;
    }
    send(res, 404, '{"error":"not found"}', "application/json");
  });
  await new Promise<void>((resolve) => server.listen(APP_PORT, "127.0.0.1", resolve));

  function killPid(pid?: number) {
    if (!pid) return;
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }

  async function runReload(label: string, keepalive: boolean, bytes: number) {
    state.arrivals = [];
    state.report = null;
    const userData = `/tmp/draft-leave-reload-${label}-${Date.now()}`;
    const child: ChildProcess = spawn(
      bin,
      [
        `--user-data-dir=${userData}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-gpu",
        `http://127.0.0.1:${APP_PORT}/?label=${encodeURIComponent(label)}&ka=${keepalive}&bytes=${bytes}&mode=reload`,
      ],
      { env: { ...process.env, DISPLAY: process.env.DISPLAY || ":1" }, stdio: "ignore" }
    );
    const started = Date.now();
    while (!state.report && Date.now() - started < 20000) await delay(100);
    killPid(child.pid);
    if (!state.report) throw new Error(`${label}: no report`);
    return state.report;
  }

  let dbg: ChildProcess | null = null;
  try {
    sectionReload();
    const smallFalse = await runReload("reload-ka-false-small", false, SMALL);
    assert(
      smallFalse.arrivals.some((a) => a.label === "reload-ka-false-small" && a.bytes === SMALL),
      "A small draft reload keepalive:false reached server"
    );

    const largeFalse = await runReload("reload-ka-false-large", false, LARGE);
    assert(
      largeFalse.arrivals.some((a) => a.label === "reload-ka-false-large" && a.bytes === LARGE),
      "B large >64KiB reload keepalive:false reached server"
    );
    assert(LARGE > LIMIT, "large body exceeds Chromium keepalive limit");

    const largeTrue = await runReload("reload-ka-true-large", true, LARGE);
    assert(
      !largeTrue.arrivals.some((a) => a.label === "reload-ka-true-large"),
      "large keepalive:true does not reach server"
    );

    dbg = spawn(
      bin,
      [
        `--user-data-dir=/tmp/draft-leave-dbg-${Date.now()}`,
        `--remote-debugging-port=${DEBUG_PORT}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-gpu",
        "about:blank",
      ],
      { env: { ...process.env, DISPLAY: process.env.DISPLAY || ":1" }, stdio: "ignore" }
    );
    const dbgStarted = Date.now();
    let dbgUp = false;
    while (Date.now() - dbgStarted < 8000) {
      try {
        const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
        if (res.ok) {
          dbgUp = true;
          break;
        }
      } catch {
        await delay(100);
      }
    }
    if (!dbgUp) throw new Error("chrome debugging port did not come up");

    async function tabClose(label: string, keepalive: boolean, bytes: number) {
      const before = state.arrivals.filter((a) => a.label === label).length;
      const openUrl = `http://127.0.0.1:${APP_PORT}/?label=${encodeURIComponent(label)}&ka=${keepalive}&bytes=${bytes}&mode=tabclose`;
      const createdRes = await fetch(
        `http://127.0.0.1:${DEBUG_PORT}/json/new?${encodeURIComponent(openUrl)}`,
        { method: "PUT" }
      );
      const created = (await createdRes.json()) as { id?: string };
      const waitFrom = Date.now();
      while (!state.ready.includes(label) && Date.now() - waitFrom < 10000) {
        await delay(50);
      }
      if (!state.ready.includes(label)) throw new Error(`${label} tab not ready`);
      await delay(150);
      if (!created.id) throw new Error(`${label} missing target id`);
      await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/close/${created.id}`).catch(() => {});
      await delay(800);
      return state.arrivals.filter((a) => a.label === label).slice(before);
    }

    const tabSmall = await tabClose("tabclose-ka-false-small", false, SMALL);
    assert(
      tabSmall.some((a) => a.bytes === SMALL),
      "tab close small keepalive:false reached server"
    );
    const tabLarge = await tabClose("tabclose-ka-false-large", false, LARGE);
    assert(
      tabLarge.some((a) => a.bytes === LARGE),
      "tab close large keepalive:false reached server"
    );
    const tabLargeTrue = await tabClose("tabclose-ka-true-large", true, LARGE);
    assert(tabLargeTrue.length === 0, "tab close large keepalive:true dropped");
  } finally {
    killPid(dbg?.pid);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  console.log(`\nCHROMIUM DONE: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

function sectionReload() {
  console.log("\n== draft leave flush chromium ==");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
