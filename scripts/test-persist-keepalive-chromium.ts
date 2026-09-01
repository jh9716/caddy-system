/**
 * Headed Chromium regression: mutation-sized POST body (>64 KiB, ~488 KiB)
 * must reach the server when keepalive is false.
 * Chromium rejects keepalive:true above 64 KiB with TypeError: Failed to fetch.
 *
 * 실행: npm run test:persist-keepalive-chromium
 */
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const PORT = 8792;
const TARGET_BYTES = 499539;
const LIMIT = 64 * 1024;

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

type CaseResult = {
  label: string;
  ok: boolean;
  status: number;
  name?: string;
  message?: string;
  serverReceived: number | null;
  keepaliveOpt: boolean;
};

type Report = {
  sickBytes: number;
  cases: CaseResult[];
};

function send(
  res: ServerResponse,
  status: number,
  body: string,
  contentType: string
) {
  res.writeHead(status, {
    "content-type": contentType,
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
  });
  res.end(body);
}

function htmlPage(): string {
  return `<!doctype html>
<meta charset="utf-8" />
<title>persist keepalive chromium</title>
<pre id="out">running…</pre>
<script>
function makeBody(targetBytes) {
  const pad = "x".repeat(Math.max(0, targetBytes - 20));
  let body = JSON.stringify({ pad });
  if (body.length < targetBytes) body += " ".repeat(targetBytes - body.length);
  return body.slice(0, targetBytes);
}
async function post(label, body, keepalive) {
  try {
    const res = await fetch("/echo?label=" + encodeURIComponent(label), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive,
    });
    const json = await res.json().catch(() => ({}));
    return {
      label,
      ok: res.ok,
      status: res.status,
      serverReceived: json.receivedBytes ?? null,
      keepaliveOpt: !!keepalive,
    };
  } catch (error) {
    return {
      label,
      ok: false,
      status: 0,
      name: error && error.name,
      message: String(error && error.message || error),
      serverReceived: null,
      keepaliveOpt: !!keepalive,
    };
  }
}
(async () => {
  const target = ${TARGET_BYTES};
  const body = makeBody(target);
  const sickBytes = new TextEncoder().encode(body).byteLength;
  const report = {
    sickBytes,
    cases: [
      await post("large-keepalive-false", body, false),
      await post("large-keepalive-true", body, true),
      await post("pad-63kib-keepalive-true", makeBody(63 * 1024), true),
    ],
  };
  document.getElementById("out").textContent = JSON.stringify(report, null, 2);
  await fetch("/report", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(report),
  });
})();
</script>
`;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function main() {
  if (process.env.DATABASE_URL && !String(process.env.DATABASE_URL).includes("caddy_local")) {
    throw new Error("this test must not use a non-local DATABASE_URL");
  }

  let report: Report | null = null;
  const arrivals: Array<{ label: string | null; receivedBytes: number }> = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
    if (req.method === "GET" && url.pathname === "/") {
      send(res, 200, htmlPage(), "text/html; charset=utf-8");
      return;
    }
    const buf = await readBody(req);
    if (url.pathname === "/echo") {
      arrivals.push({
        label: url.searchParams.get("label"),
        receivedBytes: buf.length,
      });
      send(
        res,
        200,
        JSON.stringify({ ok: true, receivedBytes: buf.length }),
        "application/json"
      );
      return;
    }
    if (url.pathname === "/report") {
      report = JSON.parse(buf.toString("utf8")) as Report;
      send(res, 200, JSON.stringify({ ok: true }), "application/json");
      return;
    }
    send(res, 404, '{"error":"not found"}', "application/json");
  });

  await new Promise<void>((resolve) => server.listen(PORT, "127.0.0.1", resolve));

  const chromeBin =
    process.env.CHROME_BIN ||
    [
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium-browser",
      "/usr/bin/chromium",
    ].find((bin) => existsSync(bin));
  if (!chromeBin) throw new Error("headed Chromium not found");
  const userData = `/tmp/persist-keepalive-chrome-${Date.now()}`;
  let child: ChildProcess | null = null;
  try {
    child = spawn(
      chromeBin || "google-chrome",
      [
        `--user-data-dir=${userData}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-gpu",
        `http://127.0.0.1:${PORT}/`,
      ],
      {
        env: { ...process.env, DISPLAY: process.env.DISPLAY || ":1" },
        stdio: "ignore",
      }
    );
    const started = Date.now();
    while (!report && Date.now() - started < 20000) {
      await delay(100);
    }
    if (!report) throw new Error("headed Chromium did not post a report");

    const falseCase = report.cases.find((c) => c.label === "large-keepalive-false");
    const trueCase = report.cases.find((c) => c.label === "large-keepalive-true");
    const smallTrue = report.cases.find((c) => c.label === "pad-63kib-keepalive-true");
    assert(report.sickBytes >= LIMIT, `body ${report.sickBytes} exceeds 64 KiB`);
    assert(
      Math.abs(report.sickBytes - TARGET_BYTES) < 32,
      `body is production-like ${report.sickBytes} bytes`
    );
    assert(falseCase?.ok === true && falseCase.status === 200, "keepalive false HTTP 200");
    assert(
      falseCase?.serverReceived === report.sickBytes,
      "keepalive false reached server with full body"
    );
    assert(
      arrivals.some(
        (a) => a.label === "large-keepalive-false" && a.receivedBytes === report!.sickBytes
      ),
      "echo log has keepalive-false arrival"
    );
    assert(
      trueCase?.ok === false && trueCase.status === 0,
      "keepalive true still TypeError / status 0"
    );
    assert(
      !arrivals.some((a) => a.label === "large-keepalive-true"),
      "keepalive true never reaches server"
    );
    assert(smallTrue?.ok === true, "63 KiB keepalive true still works");
  } finally {
    if (child && child.pid) {
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
