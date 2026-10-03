export function chatWsBaseUrl(): string {
  const fromEnv = String(process.env.NEXT_PUBLIC_CHAT_WS_URL || "").trim();
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  if (typeof window !== "undefined") {
    const host = window.location.hostname;
    if (host === "localhost" || host === "127.0.0.1") {
      return "ws://127.0.0.1:8787";
    }
  }
  return "";
}

export function chatWsUrl(input: { roomId: string; token: string }): string {
  const base = chatWsBaseUrl();
  if (!base) return "";
  const url = new URL("/ws", base.replace(/^http/i, (m) => (m.toLowerCase() === "https" ? "wss" : "ws")));
  url.searchParams.set("room", input.roomId);
  url.searchParams.set("token", input.token);
  return url.toString();
}
