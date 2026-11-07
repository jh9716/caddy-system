/**
 * Directory HTTP (list + GET /directory/rooms/:id) must send browser CORS.
 * Preview ChatClient revalidation is cross-origin from Vercel; missing ACAO makes
 * fetch() throw, so parked-socket reuse always fail-closes to a new WebSocket.
 * Local wrangler only. Auth/session-check/membership unchanged. No deploy.
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
  assert.match(index, /return withBrowserCors\(res\)/);
  assert.match(index, /from "\.\/browserCors"/);
  assert.match(cors, /access-control-allow-origin/);
  assert.match(cors, /if \(res\.status === 101\) return res/);
  assert.match(index, /const identity = await verifyIdentity\(request, env/);
});

test("GET /directory/rooms and /directory/rooms/:id send ACAO and room.roomId", async () => {
  const { port, child } = await startWrangler();
  try {
    const tok = signTestTokenV2({ userId: 21, displayName: "CorsUser", role: "caddy" });
    const origin = "https://caddy-system-preview.vercel.app";

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
    assert.equal(browserCanRead(room), true, "room JSON must be readable cross-origin (reuse revalidation)");
    const roomBody = await room.json();
    assert.equal(roomBody.ok, true);
    assert.equal(roomBody.room?.roomId, "all");

    const denied = await fetch(`http://${HOST}:${port}/directory/rooms/all`);
    assert.equal(denied.status, 401);
    assert.equal(browserCanRead(denied), true, "401 still CORS so the client can fail-close on status");

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
