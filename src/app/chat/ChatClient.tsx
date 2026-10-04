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
import {
  clearInviteIds,
  filterInviteUsers,
  invitePoolExcludingOwner,
  inviteSelectionCount,
  isRoleFullySelected,
  isTeamFullySelected,
  selectAllInviteIds,
  toggleInviteId,
  toggleRoleInviteIds,
  toggleTeamInviteIds,
  visibleInviteRoles,
  visibleInviteTeams,
} from "@/lib/chatInviteSelection";
import {
  canMentionAll,
  filterMentionSuggestions,
  insertMentionToken,
  isSelfMentioned,
  mentionQueryAtCursor,
  MENTION_ALL_LABEL,
  reconcileComposerMentions,
  reconcileMentionAll,
  splitMentionBody,
  type ComposerMention,
  type MentionCandidate,
} from "@/lib/chatMentions";
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
  mentions: number[];
  mentionAll: boolean;
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

function mentionIdsFromPayload(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const ids: number[] = [];
  const seen = new Set<number>();
  for (const item of raw) {
    const id =
      item != null && typeof item === "object" && "userId" in item
        ? Number((item as { userId: unknown }).userId)
        : Number(item);
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
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
  const [mentionTokens, setMentionTokens] = useState<ComposerMention[]>([]);
  const [mentionAllDraft, setMentionAllDraft] = useState(false);
  const [mentionCandidates, setMentionCandidates] = useState<MentionCandidate[]>([]);
  const [mentionCursor, setMentionCursor] = useState(0);
  const [mentionSuppressed, setMentionSuppressed] = useState(false);
  const [mentionLoading, setMentionLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [createName, setCreateName] = useState("");
  const [userQuery, setUserQuery] = useState("");
  const [invitePool, setInvitePool] = useState<SearchHit[]>([]);
  const [inviteLoading, setInviteLoading] = useState(false);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [creating, setCreating] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const dirRef = useRef<WebSocket | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  const tokenRef = useRef<TokenPayload | null>(null);
  const roomRef = useRef<RoomSummary | null>(null);
  const historyResetRef = useRef(true);
  const oldestSeqRef = useRef<number | null>(null);
  const loadingOlderRef = useRef(false);
  const pendingScrollRestore = useRef<number | null>(null);
  const createReqRef = useRef("");
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const mentionCacheRef = useRef<{ roomId: string; users: MentionCandidate[] } | null>(null);
  const mentionFetchedRef = useRef("");
  const mentionNamesRef = useRef<Map<number, string>>(new Map());

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
      ws.addEventListener("close", (ev) => {
        setDirectoryConnected(false);
        if (ev.code === 4008) {
          void fetchToken().then((info) => {
            if (!info) return;
            tokenRef.current = info;
            setTokenInfo(info);
            connectDirectory(info);
          });
        }
      });
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
    [applyRooms, fetchToken]
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
      historyResetRef.current = true;
      oldestSeqRef.current = null;
      setHasMore(false);
      ws.addEventListener("open", () => setConnected(true));
      ws.addEventListener("close", (ev) => {
        setConnected(false);
        if (ev.code === 4008) {
          void fetchToken().then((info) => {
            if (!info) return;
            tokenRef.current = info;
            setTokenInfo(info);
            connectDirectory(info);
            const room = roomRef.current;
            if (room) void connectSocket(info, room.roomId);
          });
        }
      });
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
            mentions: mentionIdsFromPayload(m.mentions),
            mentionAll: m.mentionAll === true,
            status: "sent" as const,
          }));
          const reset = historyResetRef.current;
          historyResetRef.current = false;
          loadingOlderRef.current = false;
          setLoadingOlder(false);
          setHasMore(data.hasMore === true);
          if (hist.length) {
            oldestSeqRef.current = Number(hist[0]!.seq);
          } else if (typeof data.oldestSeq === "number") {
            oldestSeqRef.current = data.oldestSeq;
          }
          if (reset) {
            setLines(hist);
            const last = hist[hist.length - 1];
            if (last?.seq && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "read", seq: last.seq }));
            }
          } else {
            const el = listRef.current;
            if (el) pendingScrollRestore.current = el.scrollHeight;
            setLines((prev) => {
              const seen = new Set(prev.map((l) => l.clientMessageId));
              const older = hist.filter((m) => !seen.has(m.clientMessageId));
              return [...older, ...prev];
            });
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
            mentions: mentionIdsFromPayload(data.mentions),
            mentionAll: data.mentionAll === true,
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
    [connectDirectory, fetchToken, upsertLine]
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
        try {
          await fetchRoomsHttp(info.token);
        } catch {
          // Directory WS is the realtime source; HTTP is a same-session fallback.
        }
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
    const el = listRef.current;
    if (!el) return;
    if (pendingScrollRestore.current != null) {
      el.scrollTop = el.scrollHeight - pendingScrollRestore.current;
      pendingScrollRestore.current = null;
      return;
    }
    if (!stickRef.current) return;
    el.scrollTop = el.scrollHeight;
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

  const ensureMentionCandidates = useCallback(async () => {
    const room = roomRef.current;
    const info = tokenRef.current;
    if (!room || !info) return;
    if (mentionCacheRef.current?.roomId === room.roomId) {
      setMentionCandidates(mentionCacheRef.current.users);
      setMentionLoading(false);
      return;
    }
    if (mentionFetchedRef.current === room.roomId) return;
    mentionFetchedRef.current = room.roomId;
    setMentionLoading(true);
    try {
      if (room.roomId === ALL_ROOM_ID) {
        const res = await fetch("/api/chat/users?scope=all", {
          credentials: "include",
          cache: "no-store",
        });
        if (await consumeUnauthorizedMemberResponse(res)) {
          setMentionLoading(false);
          return;
        }
        const data = await res.json().catch(() => null);
        const users = Array.isArray(data?.users)
          ? (data.users as MentionCandidate[]).map((u) => ({
              userId: Number(u.userId),
              displayName: String(u.displayName || ""),
              team: String(u.team || "-"),
              role: String(u.role || "caddy"),
            }))
          : [];
        mentionCacheRef.current = { roomId: room.roomId, users };
        for (const user of users) {
          if (user.displayName) mentionNamesRef.current.set(user.userId, user.displayName);
        }
        setMentionCandidates(users);
        setMentionLoading(false);
        return;
      }
      const url = chatDirectoryMembersUrl(room.roomId, info.token);
      if (!url) {
        setMentionLoading(false);
        return;
      }
      const res = await fetch(url, { cache: "no-store" });
      const data = await res.json().catch(() => null);
      const users = Array.isArray(data?.members)
        ? (data.members as MemberRow[]).map((m) => ({
            userId: Number(m.userId),
            displayName: String(m.displayName || ""),
            team: String(m.team || "-"),
            role: String(m.role || "caddy"),
          }))
        : [];
      mentionCacheRef.current = { roomId: room.roomId, users };
      for (const user of users) {
        if (user.displayName) mentionNamesRef.current.set(user.userId, user.displayName);
      }
      setMentionCandidates(users);
      setMentionLoading(false);
    } catch {
      mentionFetchedRef.current = "";
      setMentionLoading(false);
    }
  }, []);

  const mentionQuery = mentionQueryAtCursor(draft, mentionCursor);
  const mentionOpen = Boolean(mentionQuery && view === "room" && !sheet && !mentionSuppressed);

  useEffect(() => {
    if (mentionOpen) {
      return registerAndroidChatOverlayClose(() => setMentionSuppressed(true));
    }
    if (!sheet) return;
    return registerAndroidChatOverlayClose(() => setSheet(null));
  }, [sheet, mentionOpen]);

  useEffect(() => {
    if (!mentionOpen) return;
    void ensureMentionCandidates();
  }, [mentionOpen, ensureMentionCandidates]);

  useEffect(() => {
    if (sheet !== "create") return;
    let cancelled = false;
    setInviteLoading(true);
    void (async () => {
      const res = await fetch("/api/chat/users?scope=all", {
        credentials: "include",
        cache: "no-store",
      });
      if (await consumeUnauthorizedMemberResponse(res)) return;
      const data = await res.json().catch(() => null);
      if (cancelled) return;
      if (res.ok && Array.isArray(data?.users)) setInvitePool(data.users);
      else setInvitePool([]);
      setInviteLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [sheet]);

  async function openRoom(room: RoomSummary) {
    const info = await refreshIfNeeded();
    if (!info) return;
    roomRef.current = room;
    setActiveRoom(room);
    setView("room");
    setLines([]);
    setHasMore(false);
    setError("");
    setDraft("");
    setMentionTokens([]);
    setMentionAllDraft(false);
    setMentionSuppressed(false);
    if (mentionCacheRef.current?.roomId === room.roomId) {
      setMentionCandidates(mentionCacheRef.current.users);
    } else {
      setMentionCandidates([]);
      mentionFetchedRef.current = "";
    }
    await connectSocket(info, room.roomId);
  }

  function requestOlderHistory() {
    const ws = wsRef.current;
    const beforeSeq = oldestSeqRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !beforeSeq) return;
    if (!hasMore || loadingOlderRef.current) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    ws.send(JSON.stringify({ type: "history", beforeSeq, limit: 30 }));
  }

  async function sendCurrent(
    body: string,
    clientMessageId: string,
    tokens: ComposerMention[] = mentionTokens,
    mentionAll = mentionAllDraft
  ) {
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
    ws.send(
      JSON.stringify({
        type: "message",
        clientMessageId,
        body,
        mentions: tokens.map((t) => t.userId),
        mentionAll,
      })
    );
  }

  function applyDraft(next: string, cursor: number) {
    const tokens = reconcileComposerMentions(next, mentionTokens);
    setDraft(next);
    setMentionTokens(tokens);
    setMentionAllDraft(reconcileMentionAll(next, mentionAllDraft));
    setMentionCursor(cursor);
    setMentionSuppressed(false);
  }

  function pickMention(hit: { kind: "user" | "all"; userId: number; displayName: string }) {
    if (hit.kind === "user" && hit.displayName) {
      mentionNamesRef.current.set(hit.userId, hit.displayName);
    }
    const label = hit.kind === "all" ? MENTION_ALL_LABEL : hit.displayName;
    const inserted = insertMentionToken(draft, mentionCursor, label);
    const nextTokens =
      hit.kind === "all"
        ? mentionTokens
        : reconcileComposerMentions(inserted.text, [
            ...mentionTokens,
            { userId: hit.userId, label: hit.displayName },
          ]);
    setDraft(inserted.text);
    setMentionTokens(nextTokens);
    setMentionAllDraft(
      hit.kind === "all" ? true : reconcileMentionAll(inserted.text, mentionAllDraft)
    );
    setMentionCursor(inserted.cursor);
    setMentionSuppressed(true);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(inserted.cursor, inserted.cursor);
    });
  }

  async function handleSend() {
    const body = draft.trim();
    if (!body || sending || !tokenInfo) return;
    const tokens = reconcileComposerMentions(body, mentionTokens);
    const mentionAll = reconcileMentionAll(body, mentionAllDraft);
    const clientMessageId = newClientMessageId();
    setDraft("");
    setMentionTokens([]);
    setMentionAllDraft(false);
    setMentionSuppressed(false);
    setSending(true);
    upsertLine({
      clientMessageId,
      senderUserId: tokenInfo.user.userId,
      sender: tokenInfo.user.displayName,
      senderRole: tokenInfo.user.role,
      body,
      sentAt: new Date().toISOString(),
      mentions: tokens.map((t) => t.userId),
      mentionAll,
      status: "sending",
    });
    try {
      await sendCurrent(body, clientMessageId, tokens, mentionAll);
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
      await sendCurrent(
        line.body,
        line.clientMessageId,
        line.mentions.map((userId) => ({ userId, label: "" })),
        line.mentionAll
      );
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

  async function handleCreate() {
    if (creating) return;
    setCreating(true);
    setError("");
    try {
      if (!createReqRef.current) {
        createReqRef.current = `cr-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
      }
      const res = await fetch("/api/chat/rooms", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: createName,
          memberUserIds: selectedIds,
          clientRequestId: createReqRef.current,
        }),
      });
      if (await consumeUnauthorizedMemberResponse(res)) return;
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(data?.message || data?.error || "채팅방을 만들지 못했습니다.");
      }
      createReqRef.current = "";
      setSheet(null);
      setCreateName("");
      setSelectedIds([]);
      setInvitePool([]);
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

  const ownerUserId = tokenInfo?.user.userId ?? 0;
  const mentionSuggestions = mentionQuery
    ? filterMentionSuggestions({
        candidates: mentionCandidates,
        query: mentionQuery.query,
        canMentionAll: canMentionAll(tokenInfo?.user.role),
      })
    : [];
  const inviteCandidates = invitePoolExcludingOwner(invitePool, ownerUserId);
  const visibleInviteUsers = filterInviteUsers(inviteCandidates, userQuery);
  const inviteTeams = visibleInviteTeams(inviteCandidates);
  const inviteRoles = visibleInviteRoles(inviteCandidates);
  const selectedCount = inviteSelectionCount(selectedIds);

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
              if (el.scrollTop < 48) requestOlderHistory();
            }}
          >
            {hasMore ? (
              <button
                type="button"
                className="vh-chat-more"
                disabled={loadingOlder}
                onClick={() => requestOlderHistory()}
              >
                {loadingOlder ? "이전 메시지 불러오는 중…" : "이전 메시지"}
              </button>
            ) : null}
            {lines.map((line) => {
              const mine = tokenInfo ? line.senderUserId === tokenInfo.user.userId : false;
              const admin = line.senderRole === "admin";
              const selfMentioned = isSelfMentioned({
                myUserId: tokenInfo?.user.userId,
                mentions: line.mentions,
                mentionAll: line.mentionAll,
              });
              const nameByUserId = new Map<number, string>(mentionNamesRef.current);
              for (const c of mentionCandidates) nameByUserId.set(c.userId, c.displayName);
              for (const m of members) nameByUserId.set(m.userId, m.displayName);
              for (const token of mentionTokens) {
                if (token.label) nameByUserId.set(token.userId, token.label);
              }
              const parts = splitMentionBody(line.body, {
                mentions: line.mentions,
                mentionAll: line.mentionAll,
                nameByUserId,
              });
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
                  {selfMentioned ? <div className="vh-chat-mention-self">나를 멘션</div> : null}
                  <div className="vh-chat-body">
                    {parts.map((part, idx) =>
                      part.kind === "mention" ? (
                        <span key={`${line.clientMessageId}-m-${idx}`} className="vh-chat-mention">
                          {part.text}
                        </span>
                      ) : (
                        <span key={`${line.clientMessageId}-t-${idx}`}>{part.text}</span>
                      )
                    )}
                  </div>
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
            {mentionOpen && mentionQuery ? (
              <div className="vh-chat-suggest" role="listbox" aria-label="멘션">
                {mentionSuggestions.map((hit) => (
                  <button
                    key={hit.kind === "all" ? "all" : hit.userId}
                    type="button"
                    className="vh-chat-suggest-item"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pickMention(hit)}
                  >
                    <span>@{hit.displayName}</span>
                    {hit.secondary ? (
                      <span className="vh-chat-suggest-meta">{hit.secondary}</span>
                    ) : null}
                  </button>
                ))}
                {mentionSuggestions.length === 0 ? (
                  <p className="vh-chat-status">
                    {mentionLoading ? "멘션 목록 불러오는 중…" : "멘션할 사람이 없습니다."}
                  </p>
                ) : null}
              </div>
            ) : null}
            <div className="vh-chat-composer-row">
            <textarea
              ref={inputRef}
              className="vh-chat-input"
              rows={2}
              maxLength={2000}
              value={draft}
              placeholder="메시지 입력"
              onChange={(e) => applyDraft(e.target.value, e.target.selectionStart || 0)}
              onSelect={(e) =>
                setMentionCursor((e.target as HTMLTextAreaElement).selectionStart || 0)
              }
              onKeyUp={(e) =>
                setMentionCursor((e.target as HTMLTextAreaElement).selectionStart || 0)
              }
              onKeyDown={(e) => {
                if (e.key === "Escape" && mentionOpen) {
                  e.preventDefault();
                  setMentionSuppressed(true);
                }
              }}
            />
            <button
              type="submit"
              className="ui-btn ui-btn-primary vh-chat-send"
              disabled={!draft.trim() || sending}
            >
              전송
            </button>
            </div>
          </form>
          {!connected ? (
            <button type="button" className="vh-chat-reconnect" onClick={() => void handleReconnect()}>
              다시 연결
            </button>
          ) : null}
        </>
      )}

      {sheet === "create" ? (
        <div className="vh-chat-sheet vh-chat-sheet-create" role="dialog" aria-label="채팅방 만들기">
          <div className="vh-chat-sheet-head">
            <strong>채팅방 만들기</strong>
            <button type="button" className="vh-chat-back" onClick={() => setSheet(null)}>
              닫기
            </button>
          </div>
          <div className="vh-chat-sheet-body">
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
            <div className="vh-chat-chips" aria-label="빠른 선택">
              <button
                type="button"
                className="vh-chat-chip"
                onClick={() => setSelectedIds(selectAllInviteIds(inviteCandidates))}
              >
                전체 선택
              </button>
              <button
                type="button"
                className="vh-chat-chip"
                onClick={() => setSelectedIds(clearInviteIds())}
              >
                선택 해제
              </button>
            </div>
            {inviteTeams.length > 0 ? (
              <>
                <div className="vh-chat-chip-label">조</div>
                <div className="vh-chat-chips" aria-label="조별 선택">
                  {inviteTeams.map((chip) => (
                    <button
                      key={chip.team}
                      type="button"
                      className={`vh-chat-chip ${
                        isTeamFullySelected(selectedIds, inviteCandidates, chip.team) ? "is-on" : ""
                      }`}
                      onClick={() =>
                        setSelectedIds((prev) =>
                          toggleTeamInviteIds(prev, inviteCandidates, chip.team)
                        )
                      }
                    >
                      {chip.label}
                    </button>
                  ))}
                </div>
              </>
            ) : null}
            {inviteRoles.length > 0 ? (
              <>
                <div className="vh-chat-chip-label">역할</div>
                <div className="vh-chat-chips" aria-label="역할별 선택">
                  {inviteRoles.map((chip) => (
                    <button
                      key={chip.role}
                      type="button"
                      className={`vh-chat-chip ${
                        isRoleFullySelected(selectedIds, inviteCandidates, chip.role) ? "is-on" : ""
                      }`}
                      onClick={() =>
                        setSelectedIds((prev) =>
                          toggleRoleInviteIds(prev, inviteCandidates, chip.role)
                        )
                      }
                    >
                      {chip.label}
                    </button>
                  ))}
                </div>
              </>
            ) : null}
            <label className="vh-chat-field">
              사람 검색
              <input
                className="vh-chat-text"
                value={userQuery}
                onChange={(e) => setUserQuery(e.target.value)}
                placeholder="이름 또는 조"
              />
            </label>
            <div className="vh-chat-hits">
              {inviteLoading ? <p className="vh-chat-status">초대 목록 불러오는 중…</p> : null}
              {!inviteLoading && visibleInviteUsers.length === 0 ? (
                <p className="vh-chat-status">초대할 사용자가 없습니다.</p>
              ) : null}
              {visibleInviteUsers.map((hit) => {
                const on = selectedIds.includes(hit.userId);
                return (
                  <button
                    key={hit.userId}
                    type="button"
                    className={`vh-chat-hit ${on ? "is-on" : ""}`}
                    onClick={() =>
                      setSelectedIds((prev) => toggleInviteId(prev, hit.userId))
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
          </div>
          <div className="vh-chat-sheet-foot">
            <span className="vh-chat-select-count">선택 {selectedCount}명</span>
            <button
              type="button"
              className="ui-btn ui-btn-primary"
              disabled={!createName.trim() || creating}
              onClick={() => void handleCreate()}
            >
              {creating ? "만드는 중…" : "만들기"}
            </button>
          </div>
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
