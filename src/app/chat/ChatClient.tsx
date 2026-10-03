"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { registerAndroidChatRoomLeave } from "@/lib/androidSystemBack";
import { chatWsUrl } from "@/lib/chatClientConfig";
import { consumeUnauthorizedMemberResponse } from "@/lib/memberSessionRedirect";

type TokenPayload = {
  token: string;
  exp: number;
  room: { id: string; name: string };
  user: { userId: number; displayName: string; role: string; team: string };
};

type ChatLine = {
  clientMessageId: string;
  senderUserId: number;
  sender: string;
  body: string;
  sentAt: string;
  seq?: number;
  status: "sending" | "sent" | "failed";
};

function newClientMessageId(): string {
  return `c-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
}

export default function ChatClient() {
  const [view, setView] = useState<"list" | "room">("list");
  const [tokenInfo, setTokenInfo] = useState<TokenPayload | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  const tokenRef = useRef<TokenPayload | null>(null);

  const lastPreview = useMemo(() => {
    const sent = lines.filter((l) => l.status !== "failed");
    return sent[sent.length - 1] || null;
  }, [lines]);

  const upsertLine = useCallback((incoming: ChatLine) => {
    setLines((prev) => {
      const idx = prev.findIndex((l) => l.clientMessageId === incoming.clientMessageId);
      if (idx === -1) return [...prev, incoming];
      const next = [...prev];
      next[idx] = { ...next[idx], ...incoming };
      return next;
    });
  }, []);

  const fetchToken = useCallback(async () => {
    const res = await fetch("/api/chat/token", {
      method: "POST",
      credentials: "include",
      cache: "no-store",
    });
    if (await consumeUnauthorizedMemberResponse(res)) return null;
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(data?.message || data?.error || "채팅 입장에 실패했습니다.");
    }
    return data as TokenPayload;
  }, []);

  const connectSocket = useCallback(
    async (info: TokenPayload) => {
      const url = chatWsUrl({ roomId: info.room.id, token: info.token });
      if (!url) {
        setError("채팅 서버 주소가 없습니다.");
        return;
      }
      wsRef.current?.close();
      const ws = new WebSocket(url);
      wsRef.current = ws;
      ws.addEventListener("open", () => setConnected(true));
      ws.addEventListener("close", () => setConnected(false));
      ws.addEventListener("message", (event) => {
        let data: any;
        try {
          data = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (data.type === "history" && Array.isArray(data.messages)) {
          const hist: ChatLine[] = data.messages.map((m: any) => ({
            clientMessageId: String(m.clientMessageId),
            senderUserId: Number(m.senderUserId || 0),
            sender: String(m.sender || ""),
            body: String(m.body || ""),
            sentAt: String(m.sentAt || ""),
            seq: Number(m.seq),
            status: "sent" as const,
          }));
          setLines(hist);
          return;
        }
        if (data.type === "message") {
          upsertLine({
            clientMessageId: String(data.clientMessageId),
            senderUserId: Number(data.senderUserId || 0),
            sender: String(data.sender || ""),
            body: String(data.body || ""),
            sentAt: String(data.sentAt || new Date().toISOString()),
            seq: Number(data.seq),
            status: "sent",
          });
          return;
        }
        if (data.type === "duplicate") {
          setLines((prev) =>
            prev.map((l) =>
              l.clientMessageId === data.clientMessageId ? { ...l, status: "sent" } : l
            )
          );
        }
      });
    },
    [upsertLine]
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const info = await fetchToken();
        if (cancelled || !info) return;
        tokenRef.current = info;
        setTokenInfo(info);
        setView("room");
        await connectSocket(info);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "채팅을 열 수 없습니다.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      wsRef.current?.close();
    };
  }, [connectSocket, fetchToken]);

  useEffect(() => {
    if (!stickRef.current) return;
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, view]);

  useEffect(() => {
    if (view !== "room") return;
    return registerAndroidChatRoomLeave(() => setView("list"));
  }, [view]);

  const refreshIfNeeded = useCallback(async () => {
    const info = tokenRef.current;
    if (!info) return info;
    if (info.exp - 30 > Math.floor(Date.now() / 1000)) return info;
    const next = await fetchToken();
    if (!next) return null;
    tokenRef.current = next;
    setTokenInfo(next);
    return next;
  }, [fetchToken]);

  async function sendCurrent(body: string, clientMessageId: string) {
    const info = await refreshIfNeeded();
    if (!info) return;
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      await connectSocket(info);
    }
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error("연결되지 않았습니다.");
    }
    ws.send(JSON.stringify({ type: "message", clientMessageId, body }));
  }

  async function handleSend() {
    const body = draft.trim();
    if (!body || sending || !tokenInfo) return;
    const clientMessageId = newClientMessageId();
    setDraft("");
    setSending(true);
    upsertLine({
      clientMessageId,
      senderUserId: tokenInfo.user.userId,
      sender: tokenInfo.user.displayName,
      body,
      sentAt: new Date().toISOString(),
      status: "sending",
    });
    try {
      await sendCurrent(body, clientMessageId);
    } catch {
      setLines((prev) =>
        prev.map((l) =>
          l.clientMessageId === clientMessageId ? { ...l, status: "failed" } : l
        )
      );
    } finally {
      setSending(false);
    }
  }

  async function retry(line: ChatLine) {
    setLines((prev) =>
      prev.map((l) =>
        l.clientMessageId === line.clientMessageId ? { ...l, status: "sending" } : l
      )
    );
    try {
      await sendCurrent(line.body, line.clientMessageId);
    } catch {
      setLines((prev) =>
        prev.map((l) =>
          l.clientMessageId === line.clientMessageId ? { ...l, status: "failed" } : l
        )
      );
    }
  }

  async function handleReconnect() {
    const info = await refreshIfNeeded();
    if (!info) return;
    await connectSocket(info);
  }

  return (
    <div className="vh-chat">
      {view === "list" ? (
        <>
          <h1 className="ui-page-title">채팅</h1>
          {loading ? <p className="vh-chat-status">입장 확인 중…</p> : null}
          {error ? <p className="vh-chat-error">{error}</p> : null}
          {tokenInfo ? (
            <button
              type="button"
              className="vh-chat-room-card"
              onClick={() => setView("room")}
            >
              <div className="vh-chat-room-card-name">내 조 채팅방 · {tokenInfo.room.name}</div>
              <div className="vh-chat-room-card-preview">
                {lastPreview ? lastPreview.body : "아직 메시지가 없습니다."}
              </div>
            </button>
          ) : null}
        </>
      ) : (
        <>
          <div className="vh-chat-room-head">
            <button type="button" className="vh-chat-back" onClick={() => setView("list")}>
              목록
            </button>
            <h1 className="vh-chat-room-title">{tokenInfo?.room.name || "채팅"}</h1>
            <span className={`vh-chat-dot ${connected ? "is-on" : "is-off"}`}>
              {connected ? "연결" : "끊김"}
            </span>
          </div>
          {error ? <p className="vh-chat-error">{error}</p> : null}
          <div
            ref={listRef}
            className="vh-chat-log"
            onScroll={(e) => {
              const el = e.currentTarget;
              stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
            }}
          >
            {lines.map((line) => {
              const mine = tokenInfo ? line.senderUserId === tokenInfo.user.userId : false;
              return (
                <div
                  key={line.clientMessageId}
                  className={`vh-chat-bubble ${mine ? "is-mine" : "is-theirs"}`}
                >
                  {!mine ? <div className="vh-chat-name">{line.sender}</div> : null}
                  <div className="vh-chat-body">{line.body}</div>
                  <div className="vh-chat-meta">
                    {formatTime(line.sentAt)}
                    {mine && line.status === "sending" ? " · 보내는 중" : ""}
                    {mine && line.status === "failed" ? " · 실패" : ""}
                  </div>
                  {mine && line.status === "failed" ? (
                    <button type="button" className="vh-chat-retry" onClick={() => retry(line)}>
                      다시 보내기
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
          <form
            className="vh-chat-composer"
            onSubmit={(e) => {
              e.preventDefault();
              void handleSend();
            }}
          >
            <textarea
              className="vh-chat-input"
              rows={2}
              maxLength={2000}
              value={draft}
              placeholder="메시지 입력"
              onChange={(e) => setDraft(e.target.value)}
            />
            <button
              type="submit"
              className="ui-btn ui-btn-primary vh-chat-send"
              disabled={!draft.trim() || sending}
            >
              전송
            </button>
          </form>
          {!connected ? (
            <button type="button" className="vh-chat-reconnect" onClick={() => void handleReconnect()}>
              다시 연결
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}
