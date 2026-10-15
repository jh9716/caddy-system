/**
 * Local wrangler + mock Next /api/chat/session-check.
 * Production Worker/Next/DB are never touched.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TEST_SECRET } from "./token-helper.mjs";

export const HOST = "127.0.0.1";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.listen(0, HOST, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
    server.on("error", reject);
  });
}

export function startSessionCheckMock() {
  const epochs = new Map();
  const blocked = new Set();
  let unavailable = false;

  const server = createHttpServer((req, res) => {
    const url = String(req.url || "").split("?")[0];
    if (req.method === "POST" && url === "/api/chat/session-check") {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        res.setHeader("content-type", "application/json; charset=utf-8");
        if (unavailable) {
          res.statusCode = 503;
          res.end(JSON.stringify({ error: "auth_unavailable" }));
          return;
        }
        let body = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        } catch {
          body = {};
        }
        const userId = Number(body.userId);
        const sv = Number(body.sv);
        if (!Number.isInteger(userId) || userId <= 0) {
          res.statusCode = 401;
          res.end(JSON.stringify({ ok: false, code: "user_unavailable" }));
          return;
        }
        if (blocked.has(userId)) {
          res.statusCode = 401;
          res.end(JSON.stringify({ ok: false, code: "user_unavailable" }));
          return;
        }
        if (epochs.has(userId) && epochs.get(userId) !== sv) {
          res.statusCode = 401;
          res.end(JSON.stringify({ ok: false, code: "stale_session" }));
          return;
        }
        res.statusCode = 200;
        res.end(JSON.stringify({ ok: true, userId, sv }));
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });

  return new Promise((resolve, reject) => {
    server.listen(0, HOST, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        port,
        server,
        setEpoch(userId, sv) {
          epochs.set(userId, sv);
        },
        clearEpoch(userId) {
          epochs.delete(userId);
        },
        setBlocked(userId, value = true) {
          if (value) blocked.add(userId);
          else blocked.delete(userId);
        },
        setUnavailable(value) {
          unavailable = value === true;
        },
        close() {
          return new Promise((done) => server.close(() => done()));
        },
      });
    });
    server.on("error", reject);
  });
}

export async function startWrangler(opts = {}) {
  const mock = await startSessionCheckMock();
  const port = await freePort();
  const args = [
    "dev",
    "--local",
    "--port",
    String(port),
    "--ip",
    HOST,
    "--var",
    `CHAT_AUTH_SECRET:${TEST_SECRET}`,
    "--var",
    `CHAT_PUSH_DISPATCH_URL:http://${HOST}:${mock.port}`,
  ];
  if (opts.persistTo) {
    args.push("--persist-to", opts.persistTo);
  }
  if (Array.isArray(opts.extraArgs)) args.push(...opts.extraArgs);

  const wranglerBin = join(root, "node_modules/.bin/wrangler");
  const childEnv = {
    ...process.env,
    WRANGLER_SEND_METRICS: "false",
    CI: "1",
  };
  delete childEnv.NODE_OPTIONS;

  const child = spawn(wranglerBin, args, {
    cwd: root,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  child.__sessionCheck = mock;

  let output = "";
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`wrangler ready timeout\n${output}`));
    }, 45000);
    const onData = (buf) => {
      output += buf.toString();
      if (
        (output.includes("Ready") || output.includes("ready") || /http:\/\/127\.0\.0\.1:\d+/.test(output)) &&
        (output.includes("Ready on") ||
          output.includes(`http://${HOST}:${port}`) ||
          output.includes("Starting local server"))
      ) {
        clearTimeout(timer);
        child.stdout?.off("data", onData);
        child.stderr?.off("data", onData);
        resolve();
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`wrangler exited ${code}\n${output}`));
    });
  });
  await ready;
  await new Promise((r) => setTimeout(r, 300));
  return { port, child, mock };
}

export async function stopWrangler(child) {
  if (child?.__sessionCheck) {
    try {
      await child.__sessionCheck.close();
    } catch {
      // already closed
    }
    child.__sessionCheck = null;
  }
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      // already gone
    }
  }
  await Promise.race([once(child, "exit"), new Promise((r) => setTimeout(r, 2000))]);
  if (child.exitCode == null && child.signalCode == null) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
    await Promise.race([once(child, "exit"), new Promise((r) => setTimeout(r, 1000))]);
  }
}
