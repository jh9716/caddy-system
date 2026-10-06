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

export function chatHttpBaseUrl(): string {
  const ws = chatWsBaseUrl();
  if (ws) return ws.replace(/^ws/i, (m) => (m.toLowerCase() === "wss" ? "https" : "http"));
  const worker = String(process.env.CHAT_WORKER_URL || "").trim();
  if (worker) return worker.replace(/\/$/, "");
  if (process.env.NODE_ENV !== "production") return "http://127.0.0.1:8787";
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

export function chatDirectoryWsUrl(token: string): string {
  const base = chatWsBaseUrl();
  if (!base) return "";
  const url = new URL(
    "/directory/ws",
    base.replace(/^http/i, (m) => (m.toLowerCase() === "https" ? "wss" : "ws"))
  );
  url.searchParams.set("token", token);
  return url.toString();
}

export function chatDirectoryRoomsUrl(token: string): string {
  const base = chatHttpBaseUrl();
  if (!base) return "";
  const url = new URL("/directory/rooms", base);
  url.searchParams.set("token", token);
  return url.toString();
}

export function chatDirectoryMembersUrl(roomId: string, token: string): string {
  const base = chatHttpBaseUrl();
  if (!base) return "";
  const url = new URL(`/directory/rooms/${encodeURIComponent(roomId)}/members`, base);
  url.searchParams.set("token", token);
  return url.toString();
}

export function chatDirectoryRoomUrl(roomId: string, token: string): string {
  const base = chatHttpBaseUrl();
  if (!base) return "";
  const url = new URL(`/directory/rooms/${encodeURIComponent(roomId)}`, base);
  url.searchParams.set("token", token);
  return url.toString();
}
