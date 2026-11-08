/**
 * Directory HTTP (list + GET /directory/rooms/:id) must send browser CORS.
 * Auth / session-check / membership are unchanged. 101 WS is not rewritten.
 * Local wrangler only. No deploy.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { signTestTokenV2 } from "./token-helper.mjs";
import { HOST, startWrangler, stopWrangler } from "./wrangler-harness.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function browserCanRead(res) {
  const acao = res.headers.get("access-control-allow-origin");
  return acao === "*" || acao === "https://preview.example";
}

test("source: forwardDirectory wraps Directory HTTP with withBrowserCors", () => {
  const index = readFileSync(join(root, "src/index.ts"), "utf8");
  const cors = readFileSync(join(root, "src/browserCors.ts"), "utf8");
  const directory = readFileSync(join(root, "src/directory.ts"), "utf8");
  assert.match(index, /return withBrowserCors\(res\)/);
  assert.match(index, /from "\.\/browserCors"/);
  assert.match(cors, /access-control-allow-origin/);
  assert.match(cors, /if \(res\.status === 101\) return res/);
  assert.match(index, /const identity = await verifyIdentity\(request, env/);
  assert.doesNotMatch(
    directory,
    /access-control-allow-origin/,
    "Directory DO json() stays without CORS; Worker attaches it"
  );
});

test("GET /directory/rooms and /directory/rooms/:id send ACAO; auth still required", async () => {
  const { port, child, mock } = await startWrangler();
  try {
    mock.setEpoch(21, 2);
    const tok = signTestTokenV2({ userId: 21, displayName: "CorsUser", role: "caddy", sv: 2 });
    const origin = "https://www.verthill.kr";

    const list = await fetch(
      `http://${HOST}:${port}/directory/rooms?token=${encodeURIComponent(tok.token)}`,
      { headers: { origin } }
    );
    assert.equal(list.status, 200);
    assert.equal(browserCanRead(list), true, "list JSON must be readable cross-origin");
    const listBody = await list.json();
    assert.equal(listBody.ok, true);
    assert.ok(Array.isArray(listBody.rooms));

    const room = await fetch(
      `http://${HOST}:${port}/directory/rooms/all?token=${encodeURIComponent(tok.token)}`,
      { headers: { origin } }
    );
    assert.equal(room.status, 200);
    assert.equal(browserCanRead(room), true, "room JSON must be readable cross-origin");
    const roomBody = await room.json();
    assert.equal(roomBody.ok, true);
    assert.equal(roomBody.room?.roomId, "all");

    const denied = await fetch(`http://${HOST}:${port}/directory/rooms/all`);
    assert.equal(denied.status, 401);
    assert.equal(browserCanRead(denied), true, "401 still CORS so the client can fail-close on status");

    const stale = signTestTokenV2({ userId: 21, displayName: "CorsUser", role: "caddy", sv: 1 });
    const staleRes = await fetch(
      `http://${HOST}:${port}/directory/rooms?token=${encodeURIComponent(stale.token)}`,
      { headers: { origin } }
    );
    assert.equal(staleRes.status, 401, "CORS does not weaken session-check");
    assert.equal(browserCanRead(staleRes), true);

    const preflight = await fetch(`http://${HOST}:${port}/directory/rooms/all`, {
      method: "OPTIONS",
      headers: {
        origin,
        "access-control-request-method": "GET",
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(browserCanRead(preflight), true);

    const dirWs = await new Promise((resolve, reject) => {
      const ws = new WebSocket(
        `ws://${HOST}:${port}/directory/ws?token=${encodeURIComponent(tok.token)}`
      );
      const timer = setTimeout(() => reject(new Error("directory ws timeout")), 8000);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve(ws);
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("directory ws error"));
      });
    });
    dirWs.close();
  } finally {
    await stopWrangler(child);
  }
});
