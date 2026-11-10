/**
 * Renders an Excel clipboard table in Chrome and checks colors, text, and size.
 * Local only. No database.
 * 실행: npm run test:notice-clipboard-paste-chromium
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import ts from "typescript";

const PORT = 8797;
const DEBUG_PORT = 9227;
const OUT_DIR = "/opt/cursor/artifacts";

const EXCEL_HTML = `Version:1.0
StartHTML:0000000100
EndHTML:0000009999
<html xmlns:x="urn:schemas-microsoft-com:office:excel">
<head>
<meta name=ProgId content=Excel.Sheet>
<meta name=Generator content="Microsoft Excel 16">
<style>
<!--
td { color:black; font-size:11.0pt; font-weight:400; font-family:"맑은 고딕",monospace;
 text-align:general; vertical-align:middle; border:none; white-space:nowrap; }
.xl65 { color:white; font-weight:700; text-align:center; border:.5pt solid windowtext; background:#1F4E79; }
.xl66 { border:.5pt solid #7F7F7F; background:#FFF2CC; }
.xl67 { font-weight:700; text-align:center; border:.5pt solid windowtext; background:#C6EFCE; white-space:normal; }
-->
</style>
</head>
<body>
<table>
 <col width=120 style='width:90pt'>
 <col width=96 style='width:72pt'>
 <col width=116 style='width:87pt'>
 <tr height=22 style='height:16.5pt'>
  <td class=xl65>구분</td>
  <td class=xl65 style='border-left:none'>수량</td>
  <td class=xl65 style='border-left:none'>비고</td>
 </tr>
 <tr height=20 style='height:15.0pt'>
  <td class=xl66 style='border-top:none'>한글</td>
  <td class=xl66 align=right style='border-top:none;border-left:none' x:num="1234">1,234</td>
  <td class=xl66 style='border-top:none;border-left:none'>A-10</td>
 </tr>
 <tr height=36 style='height:27.0pt'>
  <td colspan=2 class=xl67 style='border-top:none'>병합된 셀<br>둘째 줄</td>
  <td class=xl66 style='border-top:none;border-left:none'>3</td>
 </tr>
</table>
</body>
</html>`;

function chromeBin() {
  return (
    process.env.CHROME_BIN ||
    [
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/local/bin/google-chrome",
      "/usr/bin/chromium",
    ].find((bin) => existsSync(bin))
  );
}

function transpile(rel: string) {
  const source = readFileSync(rel, "utf8");
  return ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
    },
    fileName: rel,
  }).outputText.replace(
    /from\s+["']@\/lib\/noticeClipboardPaste["']/g,
    'from "/noticeClipboardPaste.js"'
  );
}

function send(res: ServerResponse, status: number, body: string | Buffer, type: string) {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });
  res.end(body);
}

function pageHtml() {
  return `<!doctype html>
<meta charset="utf-8" />
<title>notice excel paste</title>
<style>
  @font-face { font-family: "Noto Serif KR"; font-style: normal; font-weight: 400; src: local("Noto Serif KR"); }
  body { margin: 0; background: #efe6d6; font-family: "Noto Serif KR", "Malgun Gothic", sans-serif; color: #1c1915; }
  .phone { width: 390px; margin: 12px auto; background: #fff; padding: 16px; box-sizing: border-box; }
  .hint { margin: 0 0 10px; font-size: 13px; line-height: 1.45; }
  img { width: 100%; height: auto; display: block; background: #fff; }
  #status { width: 390px; margin: 0 auto 24px; font-size: 12px; white-space: pre-wrap; }
</style>
<link rel="stylesheet" href="/noto400.css" />
<link rel="stylesheet" href="/noto700.css" />
<div class="phone">
  <p class="hint" id="hint"></p>
  <img id="preview" alt="엑셀 표 붙여넣기 미리보기" />
</div>
<pre id="status"></pre>
<script type="module">
import { NOTICE_PASTE_HINT } from "/noticeClipboardPaste.js";
import { excelClipboardHtmlToNoticePhoto, parseExcelClipboardHtml, renderExcelTableCanvas } from "/noticeExcelTableImage.js";
const html = ${JSON.stringify(EXCEL_HTML)};
try {
await Promise.race([document.fonts.ready, new Promise((resolve) => setTimeout(resolve, 4000))]);
await document.fonts.load('700 16px "Noto Serif KR"', "구분 수량 비고 병합된 셀 둘째 줄").catch((error) => {
  console.warn("font700", error);
});
await document.fonts.load('400 16px "Noto Serif KR"', "한글 1,234 A-10").catch((error) => {
  console.warn("font400", error);
});
const model = parseExcelClipboardHtml(html);
const canvas = renderExcelTableCanvas(model);
const file = await excelClipboardHtmlToNoticePhoto(html);
const scale = Number(canvas.dataset.excelScale || "1");
const rows = (canvas.dataset.excelRows || "").split(",").map(Number);
const cols = (canvas.dataset.excelCols || "").split(",").map(Number);
const ctx = canvas.getContext("2d");
function atCss(x, y) {
  const px = Math.min(canvas.width - 1, Math.max(0, Math.round(x * scale)));
  const py = Math.min(canvas.height - 1, Math.max(0, Math.round(y * scale)));
  const data = ctx.getImageData(px, py, 1, 1).data;
  return [data[0], data[1], data[2], data[3]];
}
function countPixels(x, y, w, h, pred) {
  const px = Math.round(x * scale);
  const py = Math.round(y * scale);
  const pw = Math.max(1, Math.round(w * scale));
  const ph = Math.max(1, Math.round(h * scale));
  const data = ctx.getImageData(px, py, pw, ph).data;
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (pred(data[i], data[i + 1], data[i + 2])) count += 1;
  }
  return count;
}
const headerY = 8;
const bodyY = rows[0] + 8;
const mergeY = rows[0] + rows[1] + 8;
const report = {
  width: canvas.width,
  height: canvas.height,
  scale,
  rows,
  cols,
  fileType: file.type,
  fileSize: file.size,
  hint: NOTICE_PASTE_HINT,
  header: atCss(12, headerY),
  yellow: atCss(12, bodyY),
  green: atCss(12, mergeY),
  border: (() => {
    const py = Math.min(canvas.height - 1, Math.max(0, Math.round(headerY * scale)));
    const data = ctx.getImageData(0, py, 1, 1).data;
    return [data[0], data[1], data[2], data[3]];
  })(),
  headerGlyphs: countPixels(20, 4, 80, 14, (r, g, b) => r > 200 && g > 200 && b > 200),
  amountGlyphs: countPixels(cols[0] + 8, rows[0] + 4, cols[1] - 16, 14, (r, g, b) => r < 60 && g < 60 && b < 60),
};
document.getElementById("hint").textContent = NOTICE_PASTE_HINT;
const url = URL.createObjectURL(file);
const img = document.getElementById("preview");
img.src = url;
await img.decode();
document.getElementById("status").textContent = JSON.stringify(report, null, 2);
await fetch("/report", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(report) });
} catch (error) {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  document.getElementById("status").textContent = message;
  await fetch("/report", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ error: message }) });
}
</script>`;
}

type CdpReply = {
  id?: number;
  result?: { result?: { value?: unknown }; data?: string };
  error?: { message?: string };
};

async function cdpSession(wsUrl: string) {
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("cdp websocket failed")), { once: true });
  });
  let nextId = 1;
  const pending = new Map<number, (msg: CdpReply) => void>();
  const logs: string[] = [];
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(String(ev.data)) as CdpReply & {
      method?: string;
      params?: { exceptionDetails?: { text?: string; exception?: { description?: string } }; args?: Array<{ value?: unknown; description?: string }> };
    };
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)!(msg);
      pending.delete(msg.id);
    } else if (msg.method === "Runtime.exceptionThrown") {
      logs.push(msg.params?.exceptionDetails?.exception?.description || msg.params?.exceptionDetails?.text || "exception");
    } else if (msg.method === "Runtime.consoleAPICalled") {
      logs.push((msg.params?.args || []).map((arg) => arg.value ?? arg.description ?? "").join(" "));
    }
  });
  async function send(method: string, params?: Record<string, unknown>) {
    const id = nextId++;
    const reply = new Promise<CdpReply>((resolve) => pending.set(id, resolve));
    ws.send(JSON.stringify({ id, method, params }));
    return reply;
  }
  return { ws, send, logs };
}

function near(rgb: number[] | undefined, expected: [number, number, number], slack = 18) {
  if (!rgb || rgb.length < 3) return false;
  return expected.every((channel, i) => Math.abs(channel - rgb[i]) <= slack);
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const clipJs = transpile("src/lib/noticeClipboardPaste.ts");
  const excelJs = transpile("src/lib/noticeExcelTableImage.ts");
  const fontRoot = "node_modules/@fontsource/noto-serif-kr";
  const noto400 = readFileSync(`${fontRoot}/400.css`, "utf8").replaceAll(
    "url(./files/",
    "url(/fonts/"
  );
  const noto700 = readFileSync(`${fontRoot}/700.css`, "utf8").replaceAll(
    "url(./files/",
    "url(/fonts/"
  );
  let report: Record<string, unknown> | null = null;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname === "/report" && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      req.on("end", () => {
        try {
          report = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          report = { error: "bad json" };
        }
        send(res, 200, '{"ok":true}', "application/json");
      });
      return;
    }
    if (url.pathname === "/noticeClipboardPaste.js") {
      send(res, 200, clipJs, "text/javascript; charset=utf-8");
      return;
    }
    if (url.pathname === "/noticeExcelTableImage.js") {
      send(res, 200, excelJs, "text/javascript; charset=utf-8");
      return;
    }
    if (url.pathname === "/noto400.css") {
      send(res, 200, noto400, "text/css; charset=utf-8");
      return;
    }
    if (url.pathname === "/noto700.css") {
      send(res, 200, noto700, "text/css; charset=utf-8");
      return;
    }
    if (url.pathname.startsWith("/fonts/")) {
      const name = url.pathname.slice("/fonts/".length);
      if (name.includes("..") || name.includes("/") || name.includes("\\")) {
        send(res, 404, "missing font", "text/plain");
        return;
      }
      const file = join(fontRoot, "files", name);
      if (!existsSync(file)) {
        send(res, 404, "missing font", "text/plain");
        return;
      }
      const type = name.endsWith(".woff2") ? "font/woff2" : "font/woff";
      send(res, 200, readFileSync(file), type);
      return;
    }
    send(res, 200, pageHtml(), "text/html; charset=utf-8");
  });
  await new Promise<void>((resolve) => server.listen(PORT, "127.0.0.1", resolve));

  const bin = chromeBin();
  if (!bin) throw new Error("chrome not found");
  const userData = join(tmpdir(), `notice-paste-${Date.now()}`);
  const child: ChildProcess = spawn(
    bin,
    [
      `--user-data-dir=${userData}`,
      `--remote-debugging-port=${DEBUG_PORT}`,
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--no-sandbox",
      "--window-size=480,900",
      "about:blank",
    ],
    { env: { ...process.env, DISPLAY: process.env.DISPLAY || ":1" }, stdio: "ignore" }
  );

  try {
    const started = Date.now();
    let ready = false;
    while (Date.now() - started < 15000) {
      try {
        const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
        if (res.ok) {
          ready = true;
          break;
        }
      } catch {
        await delay(150);
      }
    }
    if (!ready) throw new Error("chrome debug port did not open");

    const createdRes = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?about:blank`, {
      method: "PUT",
    });
    const createdText = await createdRes.text();
    const created = JSON.parse(createdText) as { webSocketDebuggerUrl?: string };
    if (!created.webSocketDebuggerUrl) {
      throw new Error(`no cdp websocket: ${createdRes.status} ${createdText.slice(0, 300)}`);
    }
    const session = await cdpSession(created.webSocketDebuggerUrl);
    await session.send("Page.enable");
    await session.send("Runtime.enable");
    await session.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/` });
    const waitFrom = Date.now();
    while (!report && Date.now() - waitFrom < 25000) await delay(100);
    const finished = report as Record<string, unknown> | null;
    if (!finished) {
      const evaled = await session.send("Runtime.evaluate", {
        expression: "JSON.stringify({ href: location.href, text: document.body ? document.body.innerText.slice(0, 400) : '' })",
        returnByValue: true,
      });
      throw new Error(
        `render timed out: ${JSON.stringify(evaled.result?.result?.value)} logs=${session.logs.join(" | ")}`
      );
    }
    if (finished.error) throw new Error(`render failed: ${JSON.stringify(finished)}`);

    const boxEval = await session.send("Runtime.evaluate", {
      expression: `(() => {
        const el = document.querySelector(".phone");
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      })()`,
      returnByValue: true,
    });
    const box = boxEval.result?.result?.value as
      | { x: number; y: number; width: number; height: number }
      | null
      | undefined;
    const shot = await session.send(
      "Page.captureScreenshot",
      box
        ? {
            format: "png",
            fromSurface: true,
            clip: {
              x: Math.max(0, box.x - 12),
              y: Math.max(0, box.y - 12),
              width: box.width + 24,
              height: box.height + 24,
              scale: 1,
            },
          }
        : { format: "png", fromSurface: true }
    );
    if (shot.result?.data) {
      writeFileSync(
        join(OUT_DIR, "notice-excel-paste.png"),
        Buffer.from(String(shot.result.data), "base64")
      );
    }
    writeFileSync(join(OUT_DIR, "notice-excel-paste.json"), JSON.stringify(finished, null, 2));
    session.ws.close();

    const header = finished.header as number[];
    const yellow = finished.yellow as number[];
    const green = finished.green as number[];
    const border = finished.border as number[];
    const width = Number(finished.width);
    const height = Number(finished.height);
    const problems: string[] = [];
    if (!(width >= 1200 && width <= 4096)) problems.push(`width ${width}`);
    if (!(height >= 300 && height <= 4096)) problems.push(`height ${height}`);
    if (finished.fileType !== "image/png") problems.push(`type ${String(finished.fileType)}`);
    if (!(Number(finished.fileSize) > 1000)) problems.push(`size ${String(finished.fileSize)}`);
    if (!near(header, [31, 78, 121])) problems.push(`header ${header}`);
    if (!near(yellow, [255, 242, 204])) problems.push(`yellow ${yellow}`);
    if (!near(green, [198, 239, 206])) problems.push(`green ${green}`);
    if (!border || border[0] > 80 || border[1] > 80 || border[2] > 80) problems.push(`border ${border}`);
    if (Number(finished.headerGlyphs) < 8) problems.push(`header glyphs ${finished.headerGlyphs}`);
    if (Number(finished.amountGlyphs) < 4) problems.push(`amount glyphs ${finished.amountGlyphs}`);
    if (finished.hint !== "사진·스크린샷·엑셀 표를 Ctrl+V로 붙여넣을 수 있습니다.") {
      problems.push("hint");
    }
    console.log(JSON.stringify(finished, null, 2));
    if (problems.length) {
      throw new Error(`excel render mismatch: ${problems.join("; ")}`);
    }
    console.log("excel table rendered in Chrome");
  } finally {
    if (child.pid) {
      try {
        process.kill(child.pid, "SIGTERM");
      } catch {
        /* already exited */
      }
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
