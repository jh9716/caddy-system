/**
 * Local wrangler bench: room WS open+history vs session-check count.
 * Optional mock delay (CHAT_SC_DELAY_MS) simulates Preview Next RTT.
 * No Production/Preview deploy. No DB.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { TEST_SECRET, signTestTokenV2 } from "./token-helper.mjs";
import { HOST, startWrangler, stopWrangler } from "./wrangler-harness.mjs";

const N = Number(process.env.CHAT_SC_BENCH_N || 8);
const DELAY_MS = Number(process.env.CHAT_SC_DELAY_MS || 0);
const LABEL = process.env.CHAT_SC_BENCH_LABEL || "current";
const PREVIEW = process.env.CHAT_SC_BENCH_PREVIEW === "1";
const PREVIEW_SECRET = "preview-local-bench-only";

function median(xs) {
  const s = xs.filter((x) => x != null).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
}
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

function roomEntry(port, room, token) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const ws = new WebSocket(
      `ws://${HOST}:${port}/ws?room=${encodeURIComponent(room)}&token=${encodeURIComponent(token)}`
    );
    let openMs = null;
    const got = { perf: null, historyMs: null };
    const timer = setTimeout(() => reject(new Error("room timeout")), 15000);
    ws.addEventListener("open", () => {
      openMs = performance.now() - t0;
    });
    ws.addEventListener("message", (ev) => {
      let d;
      try {
        d = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (d.type === "perf" && got.perf == null) got.perf = d.t;
      if (d.type === "history" && got.historyMs == null) got.historyMs = performance.now() - t0;
      if (got.historyMs != null && (!PREVIEW || got.perf != null)) {
        clearTimeout(timer);
        ws.close();
        resolve({ openMs, historyMs: got.historyMs, perf: got.perf });
      }
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("room ws error"));
    });
  });
}

function dirEntry(port, token) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const ws = new WebSocket(`ws://${HOST}:${port}/directory/ws?token=${encodeURIComponent(token)}`);
    const timer = setTimeout(() => reject(new Error("directory timeout")), 15000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      const openMs = performance.now() - t0;
      ws.close();
      resolve({ openMs });
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("directory ws error"));
    });
  });
}

const secret = PREVIEW ? PREVIEW_SECRET : TEST_SECRET;
const { port, child, mock } = await startWrangler({
  secret,
  extraArgs: PREVIEW ? ["--env", "preview"] : [],
});
try {
  if (DELAY_MS > 0) mock.setDelayMs(DELAY_MS);
  const tok = signTestTokenV2(
    { userId: 81, displayName: "벤치", role: "caddy", sv: 1, ...(PREVIEW ? { aud: "preview" } : {}) },
    secret
  );
  mock.setEpoch(81, 1);
  await roomEntry(port, "all", tok.token);
  await dirEntry(port, tok.token);

  const sc0 = mock.checkCount();
  const rooms = [];
  for (let i = 0; i < N; i++) rooms.push(await roomEntry(port, "all", tok.token));
  const scAfterRoom = mock.checkCount();
  const dirs = [];
  for (let i = 0; i < N; i++) dirs.push(await dirEntry(port, tok.token));
  const scAfterDir = mock.checkCount();
  const perfs = rooms.map((r) => r.perf).filter(Boolean);
  const med = (k) => r1(median(perfs.map((p) => p?.[k])));

  const summary = {
    label: LABEL,
    env: PREVIEW
      ? "local wrangler --env preview + mock session-check"
      : "local wrangler dev --local + mock session-check",
    N,
    delayMs: DELAY_MS,
    previewPerf: PREVIEW,
    roomAll: {
      sessionCheckPerEntry: (scAfterRoom - sc0) / N,
      medianOpenMs: r1(median(rooms.map((r) => r.openMs))),
      medianHistoryMs: r1(median(rooms.map((r) => r.historyMs))),
      medianScMs: med("sc"),
      medianTokMs: med("tok"),
      medianMemMs: med("mem"),
      medianEdgeMs: med("edge"),
      medianDoAssertMs: med("doAssert"),
      medianDoAcceptMs: med("doAccept"),
      medianDoHistMs: med("doHist"),
    },
    directory: {
      sessionCheckPerEntry: (scAfterDir - scAfterRoom) / N,
      medianOpenMs: r1(median(dirs.map((r) => r.openMs))),
    },
  };
  console.log(JSON.stringify(summary, null, 2));
  const out = process.env.CHAT_PERF_ARTIFACT_DIR;
  if (out) {
    mkdirSync(out, { recursive: true });
    const name = process.env.CHAT_PERF_ARTIFACT_NAME || `bench-ws-session-check-${LABEL}`;
    writeFileSync(`${out}/${name}.json`, JSON.stringify({ ...summary, raw: { rooms, dirs } }, null, 2));
  }
} finally {
  await stopWrangler(child);
}
