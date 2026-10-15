export const CHAT_DM_OPEN_FAILED = "1:1 채팅을 열지 못했습니다.";
export const CHAT_DM_START_FAILED = "1:1 채팅을 시작하지 못했습니다.";
export const CHAT_WS_OPEN_TIMEOUT_MS = 8000;

export function sanitizeChatErrorCode(code: unknown): string {
  const value = String(code ?? "").trim();
  if (/^[a-z][a-z0-9_]{0,47}$/i.test(value)) return value;
  return "unknown";
}

export function formatChatClientError(message: string, code: unknown): string {
  return `${message} [${sanitizeChatErrorCode(code)}]`;
}

export function parseChatClientErrorCode(message: string): string | null {
  const match = /\[([a-z][a-z0-9_]{0,47})\]\s*$/i.exec(String(message || ""));
  return match ? match[1]! : null;
}

export function chatWsDiagnoseUrl(wsUrl: string): string | null {
  try {
    const url = new URL(wsUrl);
    if (url.protocol === "ws:") url.protocol = "http:";
    else if (url.protocol === "wss:") url.protocol = "https:";
    else return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function chatWsFailureCode(input: {
  httpError?: unknown;
  closeCode?: number;
  timeout?: boolean;
}): string {
  if (input.timeout) return "ws_timeout";
  const http = sanitizeChatErrorCode(input.httpError);
  if (http !== "unknown") return http;
  if (input.closeCode === 4008) return "stale_session";
  if (Number.isInteger(input.closeCode) && Number(input.closeCode) > 0) {
    return `ws_${input.closeCode}`;
  }
  return "ws_error";
}

export async function diagnoseChatWsFailure(
  wsUrl: string,
  closeCode?: number,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const httpUrl = chatWsDiagnoseUrl(wsUrl);
  if (httpUrl) {
    try {
      const res = await fetchImpl(httpUrl, {
        cache: "no-store",
        redirect: "manual",
        signal: AbortSignal.timeout(2500),
      });
      const data = (await res.json().catch(() => null)) as { error?: unknown } | null;
      const fromBody = sanitizeChatErrorCode(data?.error);
      if (fromBody !== "unknown") return fromBody;
    } catch {
      // HTTP diagnose is best-effort. Never log the URL (it carries the token).
    }
  }
  return chatWsFailureCode({ closeCode });
}

export type ChatSocketOpenResult = { ok: true } | { ok: false; code: string };
