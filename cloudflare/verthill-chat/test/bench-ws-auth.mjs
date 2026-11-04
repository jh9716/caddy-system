// 로컬 합성 측정: session-check 지연 주입(80/150/300ms) 시 WS connect→history 시간과 호출 수.
// node test/bench-ws-auth.mjs  (로컬 wrangler 전용)
import WebSocket from "ws";
import { signCreateGrant, signTestTokenV2 } from "./token-helper.mjs";
import { HOST, startWrangler, stopWrangler } from "./wrangler-harness.mjs";

function enter(port, room, token) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const ws = new WebSocket(`ws://${HOST}:${port}/ws?room=${encodeURIComponent(room)}&token=${encodeURIComponent(token)}`);
    ws.on("message", (d) => {
      if (JSON.parse(String(d)).type === "history") { const ms = performance.now() - t0; ws.close(); resolve(ms); }
    });
    ws.once("unexpected-response", (_q, r) => reject(new Error(`http ${r.statusCode}`)));
    ws.once("error", reject);
  });
}
const med = (a) => { const s = [...a].sort((x, y) => x - y); return Math.round(s[Math.floor(s.length / 2)]); };
const N = 7;
const { port, child, mock } = await startWrangler();
const out = {};
try {
  const tok = signTestTokenV2({ userId: 41, displayName: "측정", role: "caddy", team: "1조", sv: 1 });
  mock.setEpoch(41, 1);
  const me = { userId: 41, displayName: "측정", role: "caddy", team: "1조" };
  const peer = { userId: 42, displayName: "상대", role: "caddy", team: "1조" };
  const now = Math.floor(Date.now() / 1000);
  const B = "room_cccccccccccccccc";
  const cr = await fetch(`http://${HOST}:${port}/directory/rooms`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ grant: signCreateGrant({ v: 1, op: "create_room", roomId: B, name: "측정방", ownerUserId: 41, members: [me, peer], iat: now, exp: now + 60 }) }) });
  if (cr.status !== 200) throw new Error(`create ${cr.status}`);
  await enter(port, "all", tok.token); await enter(port, B, tok.token); // warm
  for (const lat of [0, 80, 150, 300]) {
    mock.setDelay(lat);
    const first = [], aba = [];
    mock.resetCalls();
    for (let i = 0; i < N; i++) first.push(await enter(port, "all", tok.token));
    const callsPer = mock.sessionCheckCalls() / N;
    for (let i = 0; i < N; i++) {
      const t = performance.now();
      await enter(port, "all", tok.token); await enter(port, B, tok.token); await enter(port, "all", tok.token);
      aba.push(performance.now() - t);
    }
    mock.resetCalls();
    const custom = [];
    for (let i = 0; i < N; i++) custom.push(await enter(port, B, tok.token));
    out[lat] = { customEnterMedianMs: med(custom), enterMedianMs: med(first), abaMedianMs: med(aba), sessionChecksPerConnect: callsPer };
  }
} finally { await stopWrangler(child); }
console.log(JSON.stringify(out));
