/**
 * 채팅 목록 진입: Directory WS 는 수락 직후 rooms 스냅샷을 보낸다 → 클라이언트 open 직후 sync 는 중복.
 * 같은 로컬 wrangler(DO 실제 코드) + mock session-check 로 before(open 직후 sync 전송) / after(sync 없음)를 같은 기준으로 비교.
 * 추가로 방 WS 1회 진입당 session-check 호출 수를 센다(이 브랜치 Worker 기준 관측값, 수정 없음).
 * Local wrangler only. No Production/Preview, no DB.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { writeFileSync, mkdirSync } from "node:fs";
import { signTestTokenV2 } from "./token-helper.mjs";
import { HOST, startWrangler, stopWrangler } from "./wrangler-harness.mjs";

const N = Number(process.env.CHAT_DIR_FRAMES_N || 10);
const SETTLE_MS = 800;

function dirEntry(port, token, sendSyncOnOpen) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const ws = new WebSocket(`ws://${HOST}:${port}/directory/ws?token=${encodeURIComponent(token)}`);
    let roomsFrames = 0;
    let firstRoomsMs = null;
    let openMs = null;
    const timer = setTimeout(() => reject(new Error("directory timeout")), 10000);
    ws.addEventListener("open", () => {
      openMs = performance.now() - t0;
      if (sendSyncOnOpen) ws.send(JSON.stringify({ type: "sync" }));
      setTimeout(() => {
        clearTimeout(timer);
        ws.close();
        resolve({ roomsFrames, firstRoomsMs, openMs });
      }, SETTLE_MS);
    });
    ws.addEventListener("message", (ev) => {
      const d = JSON.parse(String(ev.data));
      if (d.type === "rooms" && Array.isArray(d.rooms)) {
        roomsFrames += 1;
        if (firstRoomsMs == null) firstRoomsMs = performance.now() - t0;
      }
    });
    ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("directory ws error")); });
  });
}

function roomEntry(port, room, token) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const ws = new WebSocket(`ws://${HOST}:${port}/ws?room=${encodeURIComponent(room)}&token=${encodeURIComponent(token)}`);
    let openMs = null;
    const timer = setTimeout(() => reject(new Error("room timeout")), 10000);
    ws.addEventListener("open", () => { openMs = performance.now() - t0; });
    ws.addEventListener("message", (ev) => {
      const d = JSON.parse(String(ev.data));
      if (d.type === "history") {
        clearTimeout(timer);
        const historyMs = performance.now() - t0;
        ws.close();
        resolve({ openMs, historyMs });
      }
    });
    ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("room ws error")); });
  });
}

const median = (xs) => { const s = xs.filter((x) => x != null).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

test("directory snapshot arrives without client sync; open-time sync only duplicates it", async () => {
  const { port, child, mock } = await startWrangler();
  let scCalls = 0;
  mock.server.on("request", (req) => { if (String(req.url || "").startsWith("/api/chat/session-check")) scCalls += 1; });
  try {
    const tok = signTestTokenV2({ userId: 71, displayName: "목록측정", role: "caddy" });
    // 워밍업(DO 생성·모듈 로드) 1회씩 — 비교에서 제외
    await dirEntry(port, tok.token, false);
    await roomEntry(port, "all", tok.token);
    const before = [], after = [];
    for (let i = 0; i < N; i++) {
      // 교차 실행으로 순서 편향 줄임
      before.push(await dirEntry(port, tok.token, true));
      after.push(await dirEntry(port, tok.token, false));
    }
    for (const r of after) assert.equal(r.roomsFrames, 1, "sync 없이도 스냅샷 정확히 1회");
    for (const r of before) assert.equal(r.roomsFrames, 2, "open 직후 sync 는 같은 스냅샷을 1회 더 받음(중복)");
    for (const r of after) assert.ok(r.firstRoomsMs != null, "첫 목록 수신");

    const scBeforeRoom = scCalls;
    const rooms = [];
    for (let i = 0; i < N; i++) rooms.push(await roomEntry(port, "all", tok.token));
    const scPerRoomEntry = (scCalls - scBeforeRoom) / N;
    const scBeforeDir = scCalls;
    for (let i = 0; i < N; i++) await dirEntry(port, tok.token, false);
    const scPerDirEntry = (scCalls - scBeforeDir) / N;

    const summary = {
      env: "local wrangler dev --local + mock session-check (127.0.0.1, 네트워크 지연 없음)",
      N,
      settleMs: SETTLE_MS,
      directory: {
        before_openSync: { roomsFramesPerEntry: before[0].roomsFrames, medianFirstRoomsMs: r1(median(before.map((r) => r.firstRoomsMs))), medianOpenMs: r1(median(before.map((r) => r.openMs))) },
        after_noSync: { roomsFramesPerEntry: after[0].roomsFrames, medianFirstRoomsMs: r1(median(after.map((r) => r.firstRoomsMs))), medianOpenMs: r1(median(after.map((r) => r.openMs))) },
        sessionCheckPerDirectoryEntry: scPerDirEntry,
      },
      roomAll: { medianOpenMs: r1(median(rooms.map((r) => r.openMs))), medianHistoryMs: r1(median(rooms.map((r) => r.historyMs))), sessionCheckPerRoomEntry: scPerRoomEntry },
      raw: { before, after, rooms },
    };
    console.log(JSON.stringify({ ...summary, raw: undefined }, null, 2));
    const out = process.env.CHAT_PERF_ARTIFACT_DIR;
    if (out) { mkdirSync(out, { recursive: true }); writeFileSync(`${out}/${process.env.CHAT_PERF_ARTIFACT_NAME || "directory-entry-frames"}.json`, JSON.stringify(summary, null, 2)); }
  } finally {
    await stopWrangler(child);
  }
});
