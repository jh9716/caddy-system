/**
 * Chromium: V1 SW activate must not wipe an unrelated origin cache.
 * 실행: npm run test:pwa-sw-cache-preserve-chromium
 */
import { existsSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const PORT = 8793;
const CACHE_NAME = "test-external-cache";

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

type Report = {
  before: string[];
  after: string[];
  has: boolean;
  kept: boolean;
  controlling: boolean;
};

function send(res: ServerResponse, status: number, body: string, type: string) {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "service-worker-allowed": "/",
  });
  res.end(body);
}

function htmlPage(): string {
  return `<!doctype html>
<meta charset="utf-8" />
<title>pwa sw cache preserve</title>
<pre id="out">running…</pre>
<script>
const CACHE_NAME = ${JSON.stringify(CACHE_NAME)};
async function run() {
  const cache = await caches.open(CACHE_NAME);
  await cache.put("/__pwa-probe", new Response("keep-me"));
  const before = await caches.keys();
  const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) {
    await new Promise((resolve) => {
      navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true });
      setTimeout(resolve, 4000);
    });
  }
  await new Promise((r) => setTimeout(r, 400));
  const after = await caches.keys();
  const opened = await caches.open(CACHE_NAME);
  const match = await opened.match("/__pwa-probe");
  const report = {
    before,
    after,
    has: after.includes(CACHE_NAME),
    kept: !!(match && (await match.text()) === "keep-me"),
    controlling: !!navigator.serviceWorker.controller,
  };
  await fetch("/report", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(report) });
  document.getElementById("out").textContent = JSON.stringify(report);
}
run().catch((e) => {
  fetch("/report", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ error: String(e) }) });
});
</script>`;
}

function chromePath(): string {
  const candidates = [
    process.env.CHROME_PATH,
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
  ].filter(Boolean) as string[];
  return candidates.find((p) => existsSync(p)) || "google-chrome";
}

async function main() {
  const swPath = join(process.cwd(), "public/sw.js");
  const swBody = readFileSync(swPath, "utf8");
  assert(!/caches\.keys/.test(swBody), "sw.js has no caches.keys");
  assert(!/caches\.delete/.test(swBody), "sw.js has no caches.delete");

  let report: Report | null = null;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url || "/";
    if (url.startsWith("/sw.js")) {
      send(res, 200, swBody, "application/javascript; charset=utf-8");
      return;
    }
    if (url.startsWith("/report") && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        try {
          report = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          report = null;
        }
        send(res, 200, '{"ok":true}', "application/json");
      });
      return;
    }
    send(res, 200, htmlPage(), "text/html; charset=utf-8");
  });

  await new Promise<void>((resolve) => server.listen(PORT, "127.0.0.1", resolve));
  const userData = mkdtempSync(join(tmpdir(), "pwa-sw-cache-"));
  let child: ChildProcess | null = null;
  try {
    child = spawn(
      chromePath(),
      [
        `--user-data-dir=${userData}`,
        "--headless=new",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-gpu",
        "--no-sandbox",
        `http://127.0.0.1:${PORT}/`,
      ],
      { stdio: "ignore" }
    );
    const started = Date.now();
    while (!report && Date.now() - started < 20000) {
      await delay(100);
    }
    if (!report) throw new Error("Chromium did not post a cache-preserve report");
    assert(report.controlling === true, "SW controls the page after activate");
    assert(report.has === true, `${CACHE_NAME} still in caches.keys()`);
    assert(report.kept === true, `${CACHE_NAME} probe body still keep-me`);
    assert(
      Array.isArray(report.before) && report.before.includes(CACHE_NAME),
      "cache existed before SW activate"
    );
  } finally {
    if (child?.pid) {
      try {
        process.kill(child.pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  console.log(`\nCHROMIUM DONE: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
