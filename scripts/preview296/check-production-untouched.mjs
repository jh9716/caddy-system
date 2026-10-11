/**
 * Read-only: Production Worker must still lack #296 upgrade capabilities.
 */
const origin = "https://verthill-chat.19970106s.workers.dev";
const res = await fetch(`${origin}/health`);
if (res.status !== 200) {
  console.error(`production /health http ${res.status}`);
  process.exit(1);
}
const body = await res.json();
if (body?.ok !== true || body?.service !== "verthill-chat") {
  console.error("unexpected production health shape", body);
  process.exit(1);
}
if (body?.capabilities) {
  console.error("production Worker now advertises capabilities; Production was changed. STOP.", body);
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, productionUntouched: true, health: body }));
