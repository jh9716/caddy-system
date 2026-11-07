/**
 * Parked resume client/server helpers. No Worker/DB.
 * 실행: npm run test:parked-resume-unit
 */
import {
  parkedResumeVerdict,
} from "../cloudflare/verthill-chat/src/parkedResume";
import { validateIncomingResume } from "../cloudflare/verthill-chat/src/protocol";
import { shouldSkipWorkerSessionCheck } from "../cloudflare/verthill-chat/src/sessionCheck";
import { withBrowserCors, BROWSER_CORS } from "../cloudflare/verthill-chat/src/browserCors";

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

function section(title: string) {
  console.log("\n==", title, "==");
}

function main() {
  section("W1 skip only /ws websocket");
  assert(shouldSkipWorkerSessionCheck("/ws", "websocket") === true, "/ws + websocket skips Worker check");
  assert(shouldSkipWorkerSessionCheck("/ws", "WebSocket") === true, "Upgrade header is case-insensitive");
  assert(shouldSkipWorkerSessionCheck("/ws", null) === false, "HTTP /ws probe still checks");
  assert(shouldSkipWorkerSessionCheck("/ws", "http") === false, "non-websocket /ws still checks");
  assert(shouldSkipWorkerSessionCheck("/directory/ws", "websocket") === false, "Directory WS still checks");
  assert(shouldSkipWorkerSessionCheck("/directory/rooms", null) === false, "Directory HTTP still checks");

  section("resume validator");
  assert(validateIncomingResume({ type: "resume" }).ok === true, "resume ok");
  assert(validateIncomingResume({ type: "history" }).ok === false, "history is not resume");

  section("fail-closed verdict");
  assert(
    parkedResumeVerdict({ session: { ok: true }, access: { ok: true } }).action === "allow",
    "login-current + member allows"
  );
  assert(
    (parkedResumeVerdict({
      session: { ok: false, status: 401, error: "stale_session" },
      access: { ok: true },
    }) as { close: string }).close === "stale_session",
    "logout / sessionVersion bump denies"
  );
  assert(
    (parkedResumeVerdict({
      session: { ok: false, status: 401, error: "user_unavailable" },
      access: { ok: true },
    }) as { close: string }).close === "stale_session",
    "retired/blocked denies"
  );
  assert(
    (parkedResumeVerdict({
      session: { ok: false, status: 503, error: "session_check_unavailable" },
      access: { ok: true },
    }) as { close: string }).close === "unavailable",
    "auth server down fail-closed"
  );
  assert(
    (parkedResumeVerdict({
      session: { ok: true },
      access: { ok: false, code: "room_forbidden" },
    }) as { close: string }).close === "room_forbidden",
    "membership removal denies"
  );

  section("CORS does not rewrite 101");
  const http = withBrowserCors(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
  assert(
    http.headers.get("access-control-allow-origin") === BROWSER_CORS["access-control-allow-origin"],
    "HTTP gets ACAO"
  );
  const fake101 = {
    status: 101,
    statusText: "Switching Protocols",
    headers: new Headers(),
    body: null,
  } as Response;
  const upgrade = withBrowserCors(fake101);
  assert(upgrade === fake101, "101 returned as-is without cloning");
  assert(
    !upgrade.headers.get("access-control-allow-origin"),
    "101 is not rewritten with CORS"
  );

  if (failed > 0) {
    console.error(`\nparked-resume unit tests failed: ${failed} (passed ${passed})`);
    process.exit(1);
  }
  console.log(`\nparked-resume unit tests passed: ${passed}`);
}

main();
