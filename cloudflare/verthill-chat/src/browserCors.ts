/**
 * Browser CORS for Worker HTTP that the browser reads (Directory JSON, health, errors).
 * Durable Object json() does not add these headers; the Worker must attach them
 * before returning Directory HTTP to the client. WebSocket 101 responses are left unchanged.
 */
export const BROWSER_CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, authorization, x-chat-media-grant",
  "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
} as const;

type MaybeWsResponse = Response & { webSocket?: unknown };

/** Copy CORS onto an HTTP response. 101 / WebSocket upgrade bodies are returned as-is. */
export function withBrowserCors(res: Response): Response {
  if (res.status === 101) return res;
  let upgrade: unknown;
  try {
    upgrade = (res as MaybeWsResponse).webSocket;
  } catch {
    upgrade = undefined;
  }
  if (upgrade) return res;
  const headers = new Headers(res.headers);
  headers.set("access-control-allow-origin", BROWSER_CORS["access-control-allow-origin"]);
  headers.set("access-control-allow-headers", BROWSER_CORS["access-control-allow-headers"]);
  headers.set("access-control-allow-methods", BROWSER_CORS["access-control-allow-methods"]);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
