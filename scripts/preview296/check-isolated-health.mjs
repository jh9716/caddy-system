/**
 * Live check for the isolated preview296 Worker only.
 * Retries briefly: a brand-new workers.dev hostname can 404 for a few seconds.
 * Does not deploy. Does not print secrets.
 */
const origin = "https://verthill-chat-preview-296.19970106s.workers.dev";
const attempts = 12;
const delayMs = 5000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let last = { http: 0, body: null };
for (let i = 1; i <= attempts; i += 1) {
  try {
    const res = await fetch(`${origin}/health`);
    last.http = res.status;
    last.body = await res.json().catch(() => null);
    const caps = last.body?.capabilities || {};
    if (
      res.status === 200 &&
      last.body?.ok === true &&
      caps.chat_media_upgrade === true &&
      caps.attachment_upgraded === true
    ) {
      console.log(
        JSON.stringify({
          ok: true,
          origin,
          http: 200,
          attempts: i,
          capabilities: {
            chat_media_upgrade: true,
            attachment_upgraded: true,
          },
        })
      );
      process.exit(0);
    }
  } catch (error) {
    last.body = { error: error instanceof Error ? error.message : String(error) };
  }
  if (i < attempts) await sleep(delayMs);
}

console.error("preview296 /health not ready", last);
process.exit(1);
