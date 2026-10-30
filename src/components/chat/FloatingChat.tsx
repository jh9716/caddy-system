"use client";

/**
 * PC 플로팅 채팅 P1.
 * - 기존 /chat(ChatClient)은 건드리지 않는다. 같은 토큰(POST /api/chat/token), 같은 Worker WS 경로·메시지 형식을 쓴다.
 * - 닫힘 상태에서는 아무 요청도 하지 않는다. 열림/최소화: 목록 소켓 1개, 방을 보고 있을 때만 방 소켓 1개.
 * - /chat 화면, 모바일(<960px), 로그인 화면에서는 렌더하지 않는다.
 * - 텍스트 전송만 지원(사진 전송·멘션·답장·삭제는 /chat 에서).
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { chatDirectoryWsUrl, chatWsUrl } from "@/lib/chatClientConfig";
import { SYNC_LIMIT, displayTombstone, lastKnownSeq, mergeChatLines } from "@/lib/chatPhase4";
import { defaultAvatarInitial, isVisibleChatListRoom, roomListTitle } from "@/lib/chatPhase5";
import { upsertVisibleChatRoom } from "@/lib/chatPhase6";
import { chatPhotoSrc } from "@/lib/chatPhotoConstants";
import { nextReconnectDelay, shouldRefreshTokenOnClose } from "@/lib/chatReconnect";
import { isDmRoomId } from "@/lib/chatRooms";
import { isChatSessionEnded, subscribeChatSessionReset } from "@/lib/chatSessionReset";
import {
  FLOATING_CHAT_BODY_MAX,
  FLOATING_CHAT_MIN_WIDTH,
  FLOATING_CHAT_STORAGE_KEY,
  canShowFloatingChat,
  floatingChatSockets,
  nextFloatingSyncAfter,
  normalizeOutgoingBody,
  shouldSendFloatingRead,
  parseFloatingChatState,
  serializeFloatingChatState,
  totalUnread,
  unreadBadgeText,
  type FloatingChatUi,
} from "@/lib/floatingChat";

type TokenPayload = {
  token: string;
  exp: number;
  user: { userId: number; displayName: string; role: string; team: string };
};

type Room = {
  roomId: string;
  name: string;
  type: "ALL" | "CUSTOM" | "DM";
  ownerUserId: number | null;
  memberCount: number;
  lastMessageSeq: number;
  lastMessagePreview: string;
  lastMessageAt: string | null;
  lastSenderName: string | null;
  lastSenderRole: string | null;
  unread: number;
  createdAt: string;
  peerUserId?: number | null;
  peerDisplayName?: string | null;
  peerRole?: string | null;
  peerTeam?: string | null;
};

type Line = {
  clientMessageId: string;
  senderUserId: number;
  sender: string;
  body: string;
  sentAt: string;
  seq?: number;
  attachments?: Array<{ id: string; size: number }>;
  deletionType?: "everyone" | "admin" | null;
  status: "sending" | "sent" | "failed";
};

type UserHit = { userId: number; displayName: string; team: string; role: string };

function toLine(raw: any): Line {
  return {
    clientMessageId: String(raw?.clientMessageId || `s-${raw?.seq || Math.random()}`),
    senderUserId: Number(raw?.senderUserId || 0),
    sender: String(raw?.sender || ""),
    body: String(raw?.body || ""),
    sentAt: String(raw?.sentAt || ""),
    seq: Number(raw?.seq) || undefined,
    attachments: Array.isArray(raw?.attachments)
      ? raw.attachments
          .map((a: any) => ({ id: String(a?.id || ""), size: Number(a?.size) || 0 }))
          .filter((a: { id: string }) => a.id)
      : [],
    deletionType:
      raw?.deletionType === "admin" || raw?.deletionType === "everyone" ? raw.deletionType : null,
    status: "sent",
  };
}

function hhmm(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
}

function newClientMessageId(): string {
  return `c-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export default function FloatingChat({ role }: { role: string | null }) {
  const pathname = usePathname() || "/";
  const [wide, setWide] = useState(false);
  const [ui, setUi] = useState<FloatingChatUi>("closed");
  const [roomId, setRoomId] = useState<string | null>(null);
  const [view, setView] = useState<"list" | "room" | "dm">("list");
  const [restored, setRestored] = useState(false);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [lines, setLines] = useState<Line[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [me, setMe] = useState<TokenPayload["user"] | null>(null);
  const [roomConnected, setRoomConnected] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [dmQuery, setDmQuery] = useState("");
  const [dmUsers, setDmUsers] = useState<UserHit[]>([]);
  const [dmLoading, setDmLoading] = useState(false);
  // 목록 스냅샷에 아직 없는 새 DM 방도 제목이 유지되도록 마지막으로 연 방 정보를 따로 보관
  const [openedMeta, setOpenedMeta] = useState<Room | null>(null);

  const tokenRef = useRef<TokenPayload | null>(null);
  const tokenPromiseRef = useRef<Promise<TokenPayload | null> | null>(null);
  const dirRef = useRef<WebSocket | null>(null);
  const roomRef = useRef<WebSocket | null>(null);
  const dirGen = useRef(0);
  const roomGen = useRef(0);
  const dirTimer = useRef<number | null>(null);
  const roomTimer = useRef<number | null>(null);
  const dirAttempt = useRef(0);
  const roomAttempt = useRef(0);
  const linesRef = useRef<Line[]>([]);
  /** 현재 방 소켓이 가리키는 방 */
  const socketRoomId = useRef<string | null>(null);
  /** 진행 중인 재연결 sync 의 afterSeq (0 = 진행 중 아님) */
  const syncAfter = useRef(0);
  const oldestSeq = useRef<number | null>(null);
  const stickRef = useRef(true);
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const launcherRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const visible = canShowFloatingChat({
    role,
    pathname,
    viewportWidth: wide ? FLOATING_CHAT_MIN_WIDTH : 0,
  });
  const viewingRoom = view === "room" && Boolean(roomId);
  const want = floatingChatSockets({ ui: visible ? ui : "closed", viewingRoom });

  // PC 폭 감지
  useEffect(() => {
    const mq = window.matchMedia(`(min-width: ${FLOATING_CHAT_MIN_WIDTH}px)`);
    const apply = () => setWide(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  // sessionStorage 복원/저장 (탭 단위)
  useEffect(() => {
    try {
      const s = parseFloatingChatState(sessionStorage.getItem(FLOATING_CHAT_STORAGE_KEY));
      setUi(s.ui);
      setRoomId(s.roomId);
      setView(s.roomId ? "room" : "list");
    } catch {
      // private mode
    }
    setRestored(true);
  }, []);
  useEffect(() => {
    if (!restored) return;
    try {
      sessionStorage.setItem(
        FLOATING_CHAT_STORAGE_KEY,
        serializeFloatingChatState({ ui, roomId: view === "room" ? roomId : null })
      );
    } catch {
      // private mode
    }
  }, [restored, ui, roomId, view]);

  const fetchToken = useCallback(async (): Promise<TokenPayload | null> => {
    if (isChatSessionEnded()) return null;
    const cur = tokenRef.current;
    if (cur && cur.exp - 30 > Math.floor(Date.now() / 1000)) return cur;
    if (tokenPromiseRef.current) return tokenPromiseRef.current;
    const p = (async () => {
      const res = await fetch("/api/chat/token", { method: "POST", credentials: "include", cache: "no-store" });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          setError("채팅을 사용할 수 없습니다. 다시 로그인해 주세요.");
          return null;
        }
        throw new Error(data?.message || "채팅 연결에 실패했습니다.");
      }
      const info = data as TokenPayload;
      if (!info?.token) return null;
      tokenRef.current = info;
      setMe(info.user);
      return info;
    })();
    tokenPromiseRef.current = p;
    try {
      return await p;
    } catch (e) {
      setError(e instanceof Error ? e.message : "채팅 연결에 실패했습니다.");
      return null;
    } finally {
      tokenPromiseRef.current = null;
    }
  }, []);

  const clearTimer = (r: { current: number | null }) => {
    if (r.current != null) {
      window.clearTimeout(r.current);
      r.current = null;
    }
  };

  /** 이벤트 무시(gen)와 별개로 실제 소켓을 닫는다. 연결 중(CONNECTING) 소켓도 닫는다. */
  const shutSocket = (ws: WebSocket | null) => {
    if (ws && ws.readyState <= WebSocket.OPEN) {
      try {
        ws.close(1000);
      } catch {
        // already closing
      }
    }
  };

  const closeDirectory = useCallback(() => {
    dirGen.current += 1;
    clearTimer(dirTimer);
    const ws = dirRef.current;
    dirRef.current = null;
    shutSocket(ws);
  }, []);

  const closeRoom = useCallback(() => {
    roomGen.current += 1;
    clearTimer(roomTimer);
    const ws = roomRef.current;
    roomRef.current = null;
    setRoomConnected(false);
    shutSocket(ws);
  }, []);

  const openDirectory = useCallback(async () => {
    const gen = ++dirGen.current;
    clearTimer(dirTimer);
    // 이전 목록 소켓이 남아 있으면 먼저 실제로 닫는다 (중복 연결 방지)
    const prevDir = dirRef.current;
    dirRef.current = null;
    shutSocket(prevDir);
    const info = await fetchToken();
    if (!info || gen !== dirGen.current) return;
    const url = chatDirectoryWsUrl(info.token);
    if (!url) {
      setError("채팅 서버 주소가 없습니다.");
      return;
    }
    shutSocket(dirRef.current);
    const ws = new WebSocket(url);
    dirRef.current = ws;
    ws.addEventListener("open", () => {
      if (gen !== dirGen.current) return;
      dirAttempt.current = 0;
      try {
        ws.send(JSON.stringify({ type: "sync" }));
      } catch {
        // snapshot still arrives
      }
    });
    ws.addEventListener("message", (ev) => {
      if (gen !== dirGen.current) return;
      let data: any;
      try {
        data = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if ((data?.type === "rooms" || data?.type === "room_summary") && Array.isArray(data.rooms)) {
        setRooms((data.rooms as Room[]).filter((r) => isVisibleChatListRoom(r.type)));
      }
    });
    ws.addEventListener("close", (ev) => {
      if (gen !== dirGen.current) return;
      if (shouldRefreshTokenOnClose(ev.code)) tokenRef.current = null;
      const delay = nextReconnectDelay(dirAttempt.current++);
      dirTimer.current = window.setTimeout(() => {
        if (gen === dirGen.current && !isChatSessionEnded()) void openDirectoryRef.current();
      }, delay);
    });
  }, [fetchToken]);
  const openDirectoryRef = useRef(openDirectory);
  openDirectoryRef.current = openDirectory;

  // 방별로 이미 보낸 마지막 read seq (재연결·방 재진입에도 유지 → 같은 seq 재전송 안 함)
  const lastReadSent = useRef(new Map<string, number>());
  const sendRead = (ws: WebSocket, seq: number | undefined) => {
    const rid = socketRoomId.current;
    if (!rid) return;
    if (!shouldSendFloatingRead(seq, lastReadSent.current.get(rid) || 0)) return;
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: "read", seq }));
        lastReadSent.current.set(rid, Number(seq));
      } catch {
        // ignore
      }
    }
  };

  const setLinesBoth = (next: Line[]) => {
    linesRef.current = next;
    setLines(next);
  };

  const openRoomSocket = useCallback(
    async (targetRoomId: string, reconnect = false) => {
      const gen = ++roomGen.current;
      clearTimer(roomTimer);
      // 방 전환·재연결 모두: 이전 방 소켓을 실제로 닫는다 (gen 무시만으로는 연결이 남는다)
      const prevRoom = roomRef.current;
      roomRef.current = null;
      setRoomConnected(false);
      shutSocket(prevRoom);
      syncAfter.current = 0;
      if (!reconnect) {
        setLinesBoth([]);
        oldestSeq.current = null;
        setHasMore(false);
        stickRef.current = true;
      }
      const info = await fetchToken();
      if (!info || gen !== roomGen.current) return;
      const url = chatWsUrl({ roomId: targetRoomId, token: info.token });
      if (!url) {
        setError("채팅 서버 주소가 없습니다.");
        return;
      }
      shutSocket(roomRef.current);
      const ws = new WebSocket(url);
      roomRef.current = ws;
      ws.addEventListener("open", () => {
        if (gen !== roomGen.current) return;
        roomAttempt.current = 0;
        setRoomConnected(true);
        const after = lastKnownSeq(linesRef.current);
        if (reconnect && after > 0) {
          try {
            syncAfter.current = after;
            ws.send(JSON.stringify({ type: "sync", afterSeq: after, limit: SYNC_LIMIT }));
          } catch {
            // history still arrives
          }
        }
      });
      ws.addEventListener("message", (ev) => {
        if (gen !== roomGen.current) return;
        let data: any;
        try {
          data = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        if (data?.type === "history" && Array.isArray(data.messages)) {
          const hist = (data.messages as unknown[]).map(toLine);
          setHasMore(data.hasMore === true);
          if (hist.length) oldestSeq.current = Number(hist[0]!.seq) || oldestSeq.current;
          const next = mergeChatLines(hist, linesRef.current);
          setLinesBoth(next);
          if (syncAfter.current === 0) sendRead(ws, lastKnownSeq(next));
          return;
        }
        if (data?.type === "sync" && Array.isArray(data.messages)) {
          // ChatClient 와 같은 규칙: hasMore=true 면 newestSeq 이후로 이어서 sync. 중복은 clientMessageId/seq 로 병합, seq 순 정렬.
          const extra = (data.messages as unknown[]).map(toLine);
          const next = mergeChatLines(linesRef.current, extra);
          setLinesBoth(next);
          const pageLast = extra.length ? Number(extra[extra.length - 1]!.seq) || 0 : 0;
          const after = nextFloatingSyncAfter({
            hasMore: data.hasMore,
            newestSeq: data.newestSeq,
            pageLastSeq: pageLast,
            requestedAfter: syncAfter.current,
          });
          if (after != null && ws.readyState === WebSocket.OPEN) {
            syncAfter.current = after;
            ws.send(JSON.stringify({ type: "sync", afterSeq: after, limit: SYNC_LIMIT }));
            return; // 마지막 페이지에서 한 번만 read
          }
          syncAfter.current = 0;
          sendRead(ws, lastKnownSeq(next));
          return;
        }
        if (data?.type === "message") {
          const extra = [toLine(data)];
          const next = mergeChatLines(linesRef.current, extra);
          setLinesBoth(next);
          if (syncAfter.current === 0) sendRead(ws, extra[0]?.seq);
          return;
        }
        if (data?.type === "duplicate" && data.clientMessageId) {
          setLinesBoth(
            linesRef.current.map((l) =>
              l.clientMessageId === data.clientMessageId ? { ...l, status: "sent" } : l
            )
          );
          return;
        }
        if (data?.type === "message_deleted" && Number(data.seq) > 0) {
          setLinesBoth(
            linesRef.current.map((l) =>
              l.seq === Number(data.seq)
                ? { ...l, deletionType: data.deletionType === "admin" ? "admin" : "everyone", body: "", attachments: [] }
                : l
            )
          );
          return;
        }
        if (data?.type === "hidden" && Number(data.seq) > 0) {
          setLinesBoth(linesRef.current.filter((l) => l.seq !== Number(data.seq)));
          return;
        }
        if (data?.type === "error") {
          setError(String(data.message || "메시지를 처리하지 못했습니다."));
        }
      });
      ws.addEventListener("close", (ev) => {
        if (gen !== roomGen.current) return;
        setRoomConnected(false);
        syncAfter.current = 0;
        if (shouldRefreshTokenOnClose(ev.code)) tokenRef.current = null;
        const delay = nextReconnectDelay(roomAttempt.current++);
        roomTimer.current = window.setTimeout(() => {
          if (gen === roomGen.current && !isChatSessionEnded()) void openRoomSocketRef.current(targetRoomId, true);
        }, delay);
      });
    },
    [fetchToken]
  );
  const openRoomSocketRef = useRef(openRoomSocket);
  openRoomSocketRef.current = openRoomSocket;

  // 소켓 수명: 원하는 상태(want)에 맞춰 열고 닫는다. 페이지 이동은 루트 레이아웃이라 재마운트되지 않는다.
  useEffect(() => {
    if (!restored) return;
    if (want.directory) {
      if (!dirRef.current) void openDirectory();
    } else {
      closeDirectory();
    }
  }, [restored, want.directory, openDirectory, closeDirectory]);

  useEffect(() => {
    if (!restored) return;
    if (want.room && roomId) {
      if (socketRoomId.current !== roomId || !roomRef.current) {
        socketRoomId.current = roomId;
        void openRoomSocket(roomId);
      }
    } else if (socketRoomId.current) {
      socketRoomId.current = null;
      closeRoom();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restored, want.room, roomId]);

  // 로그아웃·세션 교체 시 정리
  useEffect(() => {
    return subscribeChatSessionReset(() => {
      tokenRef.current = null;
      closeRoom();
      closeDirectory();
      socketRoomId.current = null;
      setRooms([]);
      lastReadSent.current.clear();
      setLinesBoth([]);
    });
  }, [closeRoom, closeDirectory]);

  // 언마운트 시 정리
  useEffect(
    () => () => {
      closeRoom();
      closeDirectory();
    },
    [closeRoom, closeDirectory]
  );

  // 새 메시지가 오면 아래에 붙어 있을 때만 따라 내려간다
  useEffect(() => {
    const el = listRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [lines, view, ui]);

  // 창을 열면 포커스 이동
  useEffect(() => {
    if (ui !== "open") return;
    const t = window.setTimeout(() => {
      if (view === "room") inputRef.current?.focus();
      else panelRef.current?.querySelector<HTMLElement>("[data-fc-focus]")?.focus();
    }, 30);
    return () => window.clearTimeout(t);
  }, [ui, view]);

  function openRoom(r: Room) {
    setError("");
    setRooms((prev) => upsertVisibleChatRoom(prev, { ...r }));
    setOpenedMeta(r);
    setRoomId(r.roomId);
    setView("room");
    setDraft("");
  }

  function backToList() {
    setView("list");
    setRoomId(null);
  }

  function minimize() {
    setUi("min");
    window.setTimeout(() => launcherRef.current?.focus(), 0);
  }

  function closeAll() {
    // 닫기 = 대화 종료(다시 열면 목록부터). 최소화는 보던 방을 유지한다.
    setUi("closed");
    setView("list");
    setRoomId(null);
    window.setTimeout(() => launcherRef.current?.focus(), 0);
  }

  async function send() {
    const body = normalizeOutgoingBody(draft);
    if (!body || !roomId) return;
    const ws = roomRef.current;
    const clientMessageId = newClientMessageId();
    const optimistic: Line = {
      clientMessageId,
      senderUserId: me?.userId || 0,
      sender: me?.displayName || "",
      body,
      sentAt: new Date().toISOString(),
      status: "sending",
    };
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setLinesBoth(mergeChatLines(linesRef.current, [{ ...optimistic, status: "failed" }]));
      setError("연결되지 않았습니다. 잠시 후 다시 보내 주세요.");
      return;
    }
    stickRef.current = true;
    setLinesBoth(mergeChatLines(linesRef.current, [optimistic]));
    setDraft("");
    try {
      // 기존 /chat 과 같은 메시지 형식 (멘션·답장·사진 없음)
      ws.send(
        JSON.stringify({
          type: "message",
          clientMessageId,
          body,
          mentions: [],
          mentionAll: false,
        })
      );
    } catch {
      setLinesBoth(
        linesRef.current.map((l) => (l.clientMessageId === clientMessageId ? { ...l, status: "failed" } : l))
      );
    }
  }

  function loadOlder() {
    const ws = roomRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !oldestSeq.current) return;
    stickRef.current = false;
    ws.send(JSON.stringify({ type: "history", beforeSeq: oldestSeq.current, limit: 30 }));
  }

  async function searchDmUsers() {
    setDmLoading(true);
    try {
      const res = await fetch("/api/chat/users?scope=all", { credentials: "include", cache: "no-store" });
      const data = await res.json().catch(() => null);
      const users: UserHit[] = Array.isArray(data?.users)
        ? (data.users as any[]).map((u) => ({
            userId: Number(u.userId),
            displayName: String(u.displayName || ""),
            team: String(u.team || "-"),
            role: String(u.role || "caddy"),
          }))
        : [];
      setDmUsers(users.filter((u) => u.userId !== me?.userId));
    } catch {
      setError("사용자 목록을 불러오지 못했습니다.");
    } finally {
      setDmLoading(false);
    }
  }

  async function startDm(peer: UserHit) {
    setError("");
    const res = await fetch("/api/chat/dm", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ peerUserId: peer.userId }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.room?.roomId) {
      setError(data?.message || "1:1 채팅을 열지 못했습니다.");
      return;
    }
    const r = data.room;
    openRoom({
      roomId: String(r.roomId),
      name: String(r.name || peer.displayName),
      type: "DM",
      ownerUserId: Number(r.ownerUserId || 0),
      memberCount: 2,
      lastMessageSeq: 0,
      lastMessagePreview: "",
      lastMessageAt: null,
      lastSenderName: null,
      lastSenderRole: null,
      unread: 0,
      createdAt: new Date().toISOString(),
      peerUserId: Number(r.peerUserId || peer.userId),
      peerDisplayName: String(r.peerDisplayName || peer.displayName),
      peerRole: String(r.peerRole || peer.role),
      peerTeam: String(r.peerTeam || peer.team || "-"),
    });
  }

  if (!visible) return null;

  const unread = totalUnread(rooms);
  const badge = unreadBadgeText(unread);
  const activeRoom =
    rooms.find((r) => r.roomId === roomId) || (openedMeta && openedMeta.roomId === roomId ? openedMeta : null);
  const title = view === "room" && activeRoom ? roomListTitle(activeRoom) : view === "dm" ? "1:1 채팅 시작" : "채팅";
  const dmFiltered = dmQuery.trim()
    ? dmUsers.filter((u) => u.displayName.includes(dmQuery.trim()))
    : dmUsers;

  if (ui !== "open") {
    return (
      <button
        ref={launcherRef}
        type="button"
        className={`vh-fc-launcher${ui === "min" ? " is-min" : ""}`}
        data-floating-chat="launcher"
        aria-label={badge ? `채팅 열기, 안 읽은 메시지 ${badge}개` : "채팅 열기"}
        onClick={() => setUi("open")}
      >
        <svg viewBox="0 0 24 24" aria-hidden>
          <path d="M5 6h14v9H10l-4 3v-3H5z" />
          <path d="M9 10h6M9 12.5h4" />
        </svg>
        <span className="vh-fc-launcher-label">{ui === "min" && activeRoom && roomId ? roomListTitle(activeRoom) : "채팅"}</span>
        {badge ? (
          <span className="vh-fc-badge" data-floating-chat="badge">
            {badge}
          </span>
        ) : null}
      </button>
    );
  }

  return (
    <div
      ref={panelRef}
      className="vh-fc-panel"
      role="dialog"
      aria-modal="false"
      aria-label="플로팅 채팅"
      data-floating-chat="panel"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          minimize();
        }
      }}
    >
      <div className="vh-fc-head">
        {view !== "list" ? (
          <button type="button" className="vh-fc-icon" aria-label="채팅방 목록" onClick={backToList}>
            ‹
          </button>
        ) : null}
        <strong className="vh-fc-title" title={title}>
          {title}
        </strong>
        {view === "room" ? (
          <span className={`vh-fc-dot${roomConnected ? " is-on" : ""}`} aria-label={roomConnected ? "연결됨" : "연결 중"} />
        ) : null}
        <Link
          className="vh-fc-full"
          href={view === "room" && roomId ? `/chat?room=${encodeURIComponent(roomId)}` : "/chat"}
          data-floating-chat="open-full"
        >
          전체 채팅 열기
        </Link>
        <button type="button" className="vh-fc-icon" aria-label="최소화" data-floating-chat="minimize" onClick={minimize}>
          –
        </button>
        <button type="button" className="vh-fc-icon" aria-label="닫기" data-floating-chat="close" onClick={closeAll}>
          ×
        </button>
      </div>
      {error ? (
        <p className="vh-fc-error" role="alert">
          {error}
        </p>
      ) : null}

      {view === "list" ? (
        <div className="vh-fc-body">
          <div className="vh-fc-listbar">
            <button
              type="button"
              className="ui-btn vh-fc-newdm"
              onClick={() => {
                setView("dm");
                if (!dmUsers.length) void searchDmUsers();
              }}
            >
              1:1 채팅 시작
            </button>
          </div>
          <ul className="vh-fc-rooms" aria-label="채팅방 목록">
            {rooms.length === 0 ? <li className="vh-fc-empty">채팅방을 불러오는 중…</li> : null}
            {rooms.map((r, i) => (
              <li key={r.roomId}>
                <button
                  type="button"
                  className="vh-fc-room"
                  data-fc-focus={i === 0 ? "1" : undefined}
                  data-floating-chat-room={r.roomId}
                  onClick={() => openRoom(r)}
                >
                  <span className={`vh-chat-avatar${r.type === "ALL" ? " is-all" : ""}`} aria-hidden>
                    {r.type === "ALL" ? "전" : defaultAvatarInitial(roomListTitle(r))}
                  </span>
                  <span className="vh-fc-room-main">
                    <span className="vh-fc-room-name">
                      {roomListTitle(r)}
                      {isDmRoomId(r.roomId) ? <em className="vh-fc-tag">1:1</em> : null}
                    </span>
                    <span className="vh-fc-room-last">{r.lastMessagePreview || "메시지 없음"}</span>
                  </span>
                  <span className="vh-fc-room-side">
                    <span className="vh-fc-room-time">{hhmm(r.lastMessageAt)}</span>
                    {r.unread > 0 ? (
                      <span className="vh-fc-badge is-inline" aria-label={`안 읽은 메시지 ${r.unread}개`}>
                        {unreadBadgeText(r.unread)}
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {view === "dm" ? (
        <div className="vh-fc-body">
          <div className="vh-fc-listbar">
            <input
              data-fc-focus="1"
              className="vh-fc-search"
              aria-label="이름 검색"
              placeholder="이름 검색"
              value={dmQuery}
              onChange={(e) => setDmQuery(e.target.value)}
            />
          </div>
          <ul className="vh-fc-rooms" aria-label="사용자 목록">
            {dmLoading ? <li className="vh-fc-empty">불러오는 중…</li> : null}
            {!dmLoading && dmFiltered.length === 0 ? <li className="vh-fc-empty">사용자가 없습니다.</li> : null}
            {dmFiltered.slice(0, 50).map((u) => (
              <li key={u.userId}>
                <button type="button" className="vh-fc-room" onClick={() => void startDm(u)}>
                  <span className="vh-chat-avatar" aria-hidden>
                    {defaultAvatarInitial(u.displayName)}
                  </span>
                  <span className="vh-fc-room-main">
                    <span className="vh-fc-room-name">{u.displayName}</span>
                    <span className="vh-fc-room-last">{u.team}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {view === "room" ? (
        <>
          <div
            className="vh-fc-msgs"
            ref={listRef}
            aria-live="polite"
            data-floating-chat="messages"
            onScroll={(e) => {
              const el = e.currentTarget;
              stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            }}
          >
            {hasMore ? (
              <button type="button" className="vh-fc-older" onClick={loadOlder}>
                이전 메시지 더 보기
              </button>
            ) : null}
            {lines.length === 0 ? <p className="vh-fc-empty">{roomConnected ? "메시지가 없습니다." : "불러오는 중…"}</p> : null}
            {lines.map((l) => {
              const mine = me != null && l.senderUserId === me.userId;
              return (
                <div
                  key={l.clientMessageId}
                  className={`vh-fc-msg${mine ? " is-mine" : ""}${l.status !== "sent" ? ` is-${l.status}` : ""}`}
                  data-floating-chat-line={l.seq || l.clientMessageId}
                >
                  {!mine ? <span className="vh-fc-sender">{l.sender}</span> : null}
                  {l.deletionType ? (
                    <span className="vh-fc-bubble is-deleted">{displayTombstone(l.deletionType)}</span>
                  ) : (
                    <>
                      {l.attachments && l.attachments.length > 0 && roomId ? (
                        <span className="vh-fc-photos">
                          {l.attachments.map((a) => (
                            <a
                              key={a.id}
                              href={chatPhotoSrc(roomId, a.id, a.size)}
                              target="_blank"
                              rel="noreferrer"
                              aria-label="사진 크게 보기"
                            >
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={chatPhotoSrc(roomId, a.id, a.size)} alt="채팅 사진" loading="lazy" />
                            </a>
                          ))}
                        </span>
                      ) : null}
                      {l.body ? <span className="vh-fc-bubble">{l.body}</span> : null}
                    </>
                  )}
                  <span className="vh-fc-time">
                    {l.status === "sending" ? "보내는 중" : l.status === "failed" ? "전송 실패" : hhmm(l.sentAt)}
                  </span>
                </div>
              );
            })}
          </div>
          <form
            className="vh-fc-compose"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <textarea
              ref={inputRef}
              aria-label="메시지 입력"
              placeholder="메시지 입력 (Enter 전송, Shift+Enter 줄바꿈)"
              rows={2}
              maxLength={FLOATING_CHAT_BODY_MAX}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <button
              type="submit"
              className="ui-btn ui-btn-primary"
              disabled={!normalizeOutgoingBody(draft) || !roomConnected}
              data-floating-chat="send"
            >
              전송
            </button>
          </form>
        </>
      ) : null}
    </div>
  );
}
