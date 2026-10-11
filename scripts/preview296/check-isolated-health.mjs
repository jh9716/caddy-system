/**
 * Live check for the isolated preview296 Worker only.
 * Does not deploy. Does not print secrets.
 */
const origin = "https://verthill-chat-preview-296.19970106s.workers.dev";
const res = await fetch(`${origin}/health`);
if (res.status !== 200) {
  console.error(`preview296 /health http ${res.status}`);
  process.exit(1);
}
const body = await res.json();
const caps = body?.capabilities || {};
if (body?.ok !== true) {
  console.error("preview296 /health ok != true");
  process.exit(1);
}
if (caps.chat_media_upgrade !== true || caps.attachment_upgraded !== true) {
  console.error("preview296 /health missing upgrade capabilities", body);
  process.exit(1);
}
if (String(origin).includes("verthill-chat.19970106s.workers.dev") && !origin.includes("preview-296")) {
  console.error("refusing to treat production worker as isolated");
  process.exit(1);
}
console.log(
  JSON.stringify({
    ok: true,
    origin,
    http: 200,
    capabilities: {
      chat_media_upgrade: true,
      attachment_upgraded: true,
    },
  })
);
