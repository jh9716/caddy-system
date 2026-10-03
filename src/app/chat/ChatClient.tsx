"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  registerAndroidChatOverlayClose,
  registerAndroidChatRoomLeave,
} from "@/lib/androidSystemBack";
import {
  chatDirectoryMembersUrl,
  chatDirectoryRoomsUrl,
  chatDirectoryWsUrl,
  chatWsUrl,
} from "@/lib/chatClientConfig";
import { ALL_ROOM_ID } from "@/lib/chatRooms";
import { consumeUnauthorizedMemberResponse } from "@/lib/memberSessionRedirect";

type TokenPayload = {
  token: string;
  exp: number;
  user: { userId: number; displayName: string; role: string; team: string };
};

type RoomSummary = {
  roomId: string;
  name: string;
  type: "ALL" | "CUSTOM";
  ownerUserId: number | null;
  memberCount: number;
  lastMessageSeq: number;
  lastMessagePreview: string;
  lastMessageAt: string | null;
  lastSenderName: string | null;
  lastSenderRole: string | null;
  unread: number;
  createdAt: string;
};

type ChatLine = {
  clientMessageId: string;
  senderUserId: number;
  sender: string;
  senderRole: string;
  body: string;
  sentAt: string;
  seq?: number;
  status: "sending" | "sent" | "failed";
};

type SearchHit = {
  userId: number;
  displayName: string;
  team: string;
  role: string;
  active: boolean;
};

type MemberRow = {
  userId: number;
  displayName: string;
  role: string;
  team: string;
};

function newClientMessageId(): string {
  return `c-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
}

function formatListTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function ChatClient() {
  const [view, setView] = useState<"list" | "room">("list");
  const [sheet, setSheet] = useState<null | "create" | "members">(null);
  const [tokenInfo, setTokenInfo] = useState<TokenPayload | null>(null);
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [activeRoom, setActiveRoom] = useState<RoomSummary | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [directoryConnected, setDirectoryConnected] = useState(false);
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [createName, setCreateName] = useState("");
  const [userQuery, setUserQuery] = useState("");
  const [userHits, setUserHits] = useState<SearchHit[]>([]);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [creating, setCreating] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const dirRef = useRef<WebSocket | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  const tokenRef = useRef<TokenPayload | null>(null);
  const roomRef = useRef<RoomSummary | null>(null);

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

  const applyRooms = useCallback((next: RoomSummary[]) => {
    const visible = next.filter((r) => r.type === "ALL" || r.type === "CUSTOM");
    setRooms(visible);
    setActiveRoom((cur) => {
      if (!cur) return cur;
      return visible.find((r) => r.roomId === cur.roomId) || cur;
    });
  }, []);

  const fetchRoomsHttp = useCallback(async (token: string) => {
    const url = chatDirectoryRoomsUrl(token);
    if (!url) return;
    const res = await fetch(url, { cache: "no-store" });
    const data = await res.json().catch(() => null);
    if (res.ok && Array.isArray(data?.rooms)) applyRooms(data.rooms);
  }, [applyRooms]);

  const connectDirectory = useCallback(
    (info: TokenPayload) => {
      const url = chatDirectoryWsUrl(info.token);
      if (!url) return;
      dirRef.current?.close();
      const ws = new WebSocket(url);
      dirRef.current = ws;
      ws.addEventListener("open", () => setDirectoryConnected(true));
      ws.addEventListener("close", () => setDirectoryConnected(false));
      ws.addEventListener("message", (event) => {
        let data: any;
        try {
          data = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if ((data.type === "rooms" || data.type === "room_summary") && Array.isArray(data.rooms)) {
          applyRooms(data.rooms);
        }
      });
    },
    [applyRooms]
  );

  const connectSocket = useCallback(
    async (info: TokenPayload, roomId: string) => {
      const url = chatWsUrl({ roomId, token: info.token });
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
            senderRole: String(m.senderRole || "caddy"),
            body: String(m.body || ""),
            sentAt: String(m.sentAt || ""),
            seq: Number(m.seq),
            status: "sent" as const,
          }));
          setLines(hist);
          const last = hist[hist.length - 1];
          if (last?.seq && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "read", seq: last.seq }));
          }
          return;
        }
        if (data.type === "message") {
          const line: ChatLine = {
            clientMessageId: String(data.clientMessageId),
            senderUserId: Number(data.senderUserId || 0),
            sender: String(data.sender || ""),
            senderRole: String(data.senderRole || "caddy"),
            body: String(data.body || ""),
            sentAt: String(data.sentAt || new Date().toISOString()),
            seq: Number(data.seq),
            status: "sent",
          };
          upsertLine(line);
          if (line.seq && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "read", seq: line.seq }));
          }
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
        connectDirectory(info);
        await fetchRoomsHttp(info.token);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "채팅을 열 수 없습니다.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      wsRef.current?.close();
      dirRef.current?.close();
    };
  }, [connectDirectory, fetchRoomsHttp, fetchToken]);

  useEffect(() => {
    if (!stickRef.current) return;
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, view]);

  useEffect(() => {
    if (view !== "room") return;
    return registerAndroidChatRoomLeave(() => {
      setView("list");
      setActiveRoom(null);
      roomRef.current = null;
      wsRef.current?.close();
      setLines([]);
    });
  }, [view]);

  useEffect(() => {
    if (!sheet) return;
    return registerAndroidChatOverlayClose(() => setSheet(null));
  }, [sheet]);

  const refreshIfNeeded = useCallback(async () => {
    const info = tokenRef.current;
    if (!info) return info;
    if (info.exp - 30 > Math.floor(Date.now() / 1000)) return info;
    const next = await fetchToken();
    if (!next) return null;
    tokenRef.current = next;
    setTokenInfo(next);
    connectDirectory(next);
    return next;
  }, [connectDirectory, fetchToken]);

  async function openRoom(room: RoomSummary) {
    const info = await refreshIfNeeded();
    if (!info) return;
    roomRef.current = room;
    setActiveRoom(room);
    setView("room");
    setLines([]);
    setError("");
    await connectSocket(info, room.roomId);
  }

  async function sendCurrent(body: string, clientMessageId: string) {
    const info = await refreshIfNeeded();
    const room = roomRef.current;
    if (!info || !room) return;
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      await connectSocket(info, room.roomId);
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
      senderRole: tokenInfo.user.role,
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
    const room = roomRef.current;
    if (!info || !room) return;
    await connectSocket(info, room.roomId);
  }

  async function searchUsers(q: string) {
    setUserQuery(q);
    if (!q.trim()) {
      setUserHits([]);
      return;
    }
    const res = await fetch(`/api/chat/users?q=${encodeURIComponent(q.trim())}`, {
      credentials: "include",
      cache: "no-store",
    });
    if (await consumeUnauthorizedMemberResponse(res)) return;
    const data = await res.json().catch(() => null);
    if (res.ok && Array.isArray(data?.users)) setUserHits(data.users);
  }

  async function handleCreate() {
    if (creating) return;
    setCreating(true);
    setError("");
    try {
      const res = await fetch("/api/chat/rooms", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: createName, memberUserIds: selectedIds }),
      });
      if (await consumeUnauthorizedMemberResponse(res)) return;
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(data?.message || data?.error || "채팅방을 만들지 못했습니다.");
      }
      setSheet(null);
      setCreateName("");
      setSelectedIds([]);
      setUserHits([]);
      setUserQuery("");
      const info = tokenRef.current;
      if (info) await fetchRoomsHttp(info.token);
    } catch (e) {
      setError(e instanceof Error ? e.message : "채팅방을 만들지 못했습니다.");
    } finally {
      setCreating(false);
    }
  }

  async function openMembers() {
    const info = await refreshIfNeeded();
    const room = roomRef.current;
    if (!info || !room) return;
    if (room.roomId === ALL_ROOM_ID) {
      setMembers([]);
      setSheet("members");
      return;
    }
    const url = chatDirectoryMembersUrl(room.roomId, info.token);
    if (!url) return;
    const res = await fetch(url, { cache: "no-store" });
    const data = await res.json().catch(() => null);
    if (res.ok && Array.isArray(data?.members)) setMembers(data.members);
    else setMembers([]);
    setSheet("members");
  }

  return (
    <div className="vh-chat">
      {view === "list" ? (
        <>
          <div className="vh-chat-list-head">
            <h1 className="ui-page-title">채팅</h1>
            <button type="button" className="vh-chat-create-btn" onClick={() => setSheet("create")}>
              + 채팅방 만들기
            </button>
          </div>
          {loading ? <p className="vh-chat-status">입장 확인 중…</p> : null}
          {error ? <p className="vh-chat-error">{error}</p> : null}
          {!directoryConnected && !loading ? (
            <p className="vh-chat-status">목록 연결 대기 중…</p>
          ) : null}
          <div className="vh-chat-room-list">
            {rooms.map((room) => (
              <button
                key={room.roomId}
                type="button"
                className={`vh-chat-room-card ${room.type === "ALL" ? "is-all" : ""}`}
                onClick={() => void openRoom(room)}
              >
                <div className="vh-chat-room-card-top">
                  <div className="vh-chat-room-card-name">{room.name}</div>
                  <div className="vh-chat-room-card-time">{formatListTime(room.lastMessageAt)}</div>
                </div>
                <div className="vh-chat-room-card-bottom">
                  <div className="vh-chat-room-card-preview">
                    {room.lastMessagePreview
                      ? `${room.lastSenderName ? `${room.lastSenderName}: ` : ""}${room.lastMessagePreview}`
                      : "아직 메시지가 없습니다."}
                  </div>
                  {room.unread > 0 ? (
                    <span className="vh-chat-unread">{room.unread > 99 ? "99+" : room.unread}</span>
                  ) : null}
                </div>
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="vh-chat-room-head">
            <button
              type="button"
              className="vh-chat-back"
              onClick={() => {
                setView("list");
                setActiveRoom(null);
                roomRef.current = null;
                wsRef.current?.close();
                setLines([]);
              }}
            >
              목록
            </button>
            <button type="button" className="vh-chat-room-title-btn" onClick={() => void openMembers()}>
              <h1 className="vh-chat-room-title">{activeRoom?.name || "채팅"}</h1>
              {activeRoom && activeRoom.type === "CUSTOM" ? (
                <span className="vh-chat-member-count">{activeRoom.memberCount}명</span>
              ) : null}
            </button>
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
              const admin = line.senderRole === "admin";
              return (
                <div
                  key={line.clientMessageId}
                  className={`vh-chat-bubble ${mine ? "is-mine" : "is-theirs"} ${admin ? "is-admin" : ""}`}
                >
                  {admin ? (
                    <div className="vh-chat-admin-badge">🛡 관리자 · {line.sender}</div>
                  ) : !mine ? (
                    <div className="vh-chat-name">{line.sender}</div>
                  ) : null}
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

      {sheet === "create" ? (
        <div className="vh-chat-sheet" role="dialog" aria-label="채팅방 만들기">
          <div className="vh-chat-sheet-head">
            <strong>채팅방 만들기</strong>
            <button type="button" className="vh-chat-back" onClick={() => setSheet(null)}>
              닫기
            </button>
          </div>
          <label className="vh-chat-field">
            방 이름
            <input
              className="vh-chat-text"
              maxLength={24}
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              placeholder="예: 대바"
            />
          </label>
          <label className="vh-chat-field">
            사람 검색
            <input
              className="vh-chat-text"
              value={userQuery}
              onChange={(e) => void searchUsers(e.target.value)}
              placeholder="이름 또는 조"
            />
          </label>
          <div className="vh-chat-hits">
            {userHits.map((hit) => {
              const on = selectedIds.includes(hit.userId);
              return (
                <button
                  key={hit.userId}
                  type="button"
                  className={`vh-chat-hit ${on ? "is-on" : ""}`}
                  onClick={() =>
                    setSelectedIds((prev) =>
                      prev.includes(hit.userId)
                        ? prev.filter((id) => id !== hit.userId)
                        : [...prev, hit.userId]
                    )
                  }
                >
                  <span>{hit.displayName}</span>
                  <span className="vh-chat-hit-meta">
                    {hit.team !== "-" ? hit.team : hit.role}
                  </span>
                </button>
              );
            })}
          </div>
          <button
            type="button"
            className="ui-btn ui-btn-primary"
            disabled={!createName.trim() || creating}
            onClick={() => void handleCreate()}
          >
            {creating ? "만드는 중…" : "만들기"}
          </button>
        </div>
      ) : null}

      {sheet === "members" ? (
        <div className="vh-chat-sheet" role="dialog" aria-label="멤버">
          <div className="vh-chat-sheet-head">
            <strong>멤버</strong>
            <button type="button" className="vh-chat-back" onClick={() => setSheet(null)}>
              닫기
            </button>
          </div>
          {activeRoom?.roomId === ALL_ROOM_ID ? (
            <p className="vh-chat-status">전체 채팅방은 모든 활성 사용자가 참여합니다.</p>
          ) : (
            <ul className="vh-chat-members">
              {members.map((m) => (
                <li key={m.userId}>
                  <strong>{m.displayName}</strong>
                  <span>
                    {m.role}
                    {m.team !== "-" ? ` · ${m.team}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
