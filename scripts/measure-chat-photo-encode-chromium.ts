/**
 * Local Chrome encode benchmark for Chat Photo Phase 10.
 * No Production write. Numeric timings only.
 */
import { createServer, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const PORT = 8798;
const DEBUG_PORT = 9226;
const OUT = "/opt/cursor/artifacts/chat-photo-phase10-encode.json";

function chromeBin() {
  return (
    process.env.CHROME_BIN ||
    ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium-browser", "/usr/bin/chromium"].find(
      (bin) => existsSync(bin)
    )
  );
}

function send(res: ServerResponse, status: number, body: string, type: string) {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

function pageHtml() {
  return `<!doctype html>
<meta charset="utf-8" />
<title>chat photo encode bench</title>
<pre id="out">running</pre>
<script>
async function canvasToBlob(canvas, type, quality) {
  if (canvas.convertToBlob) return canvas.convertToBlob({ type, quality });
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("encode"))), type, quality);
  });
}
async function makeSource(width, height) {
  const c = new OffscreenCanvas(width, height);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#335577";
  ctx.fillRect(0, 0, width, height);
  for (let i = 0; i < 80; i++) {
    ctx.fillStyle = i % 2 ? "#e8d7b0" : "#2a6f4f";
    ctx.fillRect((i * 47) % width, (i * 31) % height, 180, 120);
  }
  return c.convertToBlob({ type: "image/jpeg", quality: 0.92 });
}
async function encodeOnce(bitmap, mime, quality, longEdge) {
  const scale = Math.min(1, longEdge / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext("2d");
  const draw0 = performance.now();
  ctx.drawImage(bitmap, 0, 0, w, h);
  const drawMs = performance.now() - draw0;
  const enc0 = performance.now();
  const blob = await canvasToBlob(c, mime, quality);
  return { drawMs, encodeMs: performance.now() - enc0, bytes: blob.size, w, h, mime: blob.type || mime };
}
async function run() {
  const src = await makeSource(4000, 3000);
  const dec0 = performance.now();
  const bitmap = await createImageBitmap(src, { imageOrientation: "from-image" });
  const decodeMs = performance.now() - dec0;
  const jpeg1 = await encodeOnce(bitmap, "image/jpeg", 0.82, 1600);
  const webp1 = await encodeOnce(bitmap, "image/webp", 0.82, 1600);
  const jpeg2 = await encodeOnce(bitmap, "image/jpeg", 0.7, 1600);
  const webp2 = await encodeOnce(bitmap, "image/webp", 0.7, 1600);
  const out = {
    sourceBytes: src.size,
    decodeMs: Math.round(decodeMs),
    jpeg1: { ...jpeg1, drawMs: Math.round(jpeg1.drawMs), encodeMs: Math.round(jpeg1.encodeMs) },
    webp1: { ...webp1, drawMs: Math.round(webp1.drawMs), encodeMs: Math.round(webp1.encodeMs) },
    jpeg2: { ...jpeg2, drawMs: Math.round(jpeg2.drawMs), encodeMs: Math.round(jpeg2.encodeMs) },
    webp2: { ...webp2, drawMs: Math.round(webp2.drawMs), encodeMs: Math.round(webp2.encodeMs) },
    oldPathMs: Math.round(decodeMs + webp1.drawMs + webp1.encodeMs + webp2.encodeMs),
    newPathMs: Math.round(decodeMs + jpeg1.drawMs + jpeg1.encodeMs),
  };
  document.getElementById("out").textContent = JSON.stringify(out);
  await fetch("/report", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(out) });
}
run().catch(async (e) => {
  const err = { error: String(e && e.message || e) };
  document.getElementById("out").textContent = JSON.stringify(err);
  await fetch("/report", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(err) });
});
</script>`;
}

async function main() {
  const bin = chromeBin();
  if (!bin) throw new Error("chrome not found");
  mkdirSync("/opt/cursor/artifacts", { recursive: true });
  let bench: Record<string, unknown> | null = null;
  const server = createServer((req, res) => {
    if ((req.url || "").startsWith("/report") && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      req.on("end", () => {
        try {
          bench = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          bench = { error: "bad json" };
        }
        send(res, 200, '{"ok":true}', "application/json");
      });
      return;
    }
    send(res, 200, pageHtml(), "text/html; charset=utf-8");
  });
  await new Promise<void>((resolve) => server.listen(PORT, "127.0.0.1", resolve));
  const profile = join(tmpdir(), `chat-photo-encode-${Date.now()}`);
  mkdirSync(profile, { recursive: true });
  const chrome: ChildProcess = spawn(
    bin,
    [
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${profile}`,
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-sandbox",
      `http://127.0.0.1:${PORT}/`,
    ],
    { stdio: "ignore" }
  );
  try {
    const started = Date.now();
    while (!bench && Date.now() - started < 25000) await delay(150);
    if (!bench || bench.error) throw new Error(`bench failed ${JSON.stringify(bench)}`);
    writeFileSync(OUT, JSON.stringify(bench, null, 2));
    console.log(JSON.stringify(bench, null, 2));
  } finally {
    chrome.kill("SIGTERM");
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
