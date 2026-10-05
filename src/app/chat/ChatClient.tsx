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
  applyDeletedLine,
  applyHiddenSeq,
  chatActionItems,
  displayTombstone,
  lastKnownSeq,
  mergeChatLines,
  nextSyncCursor,
  redactHiddenReplies,
  SYNC_LIMIT,
  type ChatLineReply,
} from "@/lib/chatPhase4";
import {
  canProfileMention,
  chatAuthorLine,
  chatRoleLabel,
  defaultAvatarInitial,
  formatChatDateDivider,
  isVisibleChatListRoom,
  jumpToMessageIfMounted,
  publicChatProfile,
  roomListTitle,
  shouldShowAuthorMeta,
  shouldShowDateDivider,
  shouldShowJumpButton,
} from "@/lib/chatPhase5";
import {
  clearPendingChatRoomId,
  parseChatDeepLinkRoomId,
  readPendingChatRoomId,
  resolveChatDeepLinkAction,
  rollbackOptimisticChatRoom,
  upsertVisibleChatRoom,
} from "@/lib/chatPhase6";
import {
  DEFAULT_CHAT_NOTIFY_MODE,
  type ChatNotifyMode,
} from "@/lib/chatNotificationPref";
import {
  chatReconnectStatus,
  nextReconnectDelay,
  shouldRefreshTokenOnClose,
} from "@/lib/chatReconnect";
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
import { ALL_ROOM_ID, isDmRoomId } from "@/lib/chatRooms";
import { consumeUnauthorizedMemberResponse } from "@/lib/memberSessionRedirect";

type TokenPayload = {
  token: string;
  exp: number;
  user: { userId: number; displayName: string; role: string; team: string };
};

type RoomSummary = {
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

type ProfileTarget = {
  userId: number;
  displayName: string;
  team: string;
  role: string;
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
  replyToSeq?: number | null;
  replyTo?: ChatLineReply | null;
  deletionType?: "everyone" | "admin" | null;
  deletedAt?: string | null;
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
  const [sheet, setSheet] = useState<null | "create" | "members" | "notify">(null);
  const [notifyPrefs, setNotifyPrefs] = useState<Record<string, ChatNotifyMode>>({});
  const deepLinkTriedRef = useRef("");
  const [tokenInfo, setTokenInfo] = useState<TokenPayload | null>(null);
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [activeRoom, setActiveRoom] = useState<RoomSummary | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [directoryConnected, setDirectoryConnected] = useState(false);
  const [directorySnapshotReady, setDirectorySnapshotReady] = useState(false);
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
  const [replyTo, setReplyTo] = useState<ChatLineReply | null>(null);
  const [actionLine, setActionLine] = useState<ChatLine | null>(null);
  const [profileTarget, setProfileTarget] = useState<ProfileTarget | null>(null);
  const [unseenCount, setUnseenCount] = useState(0);
  const [failingSince, setFailingSince] = useState<number | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());
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
  const roomGenRef = useRef(0);
  const dirGenRef = useRef(0);
  const roomTimerRef = useRef<number | null>(null);
  const dirTimerRef = useRef<number | null>(null);
  const roomAttemptRef = useRef(0);
  const dirAttemptRef = useRef(0);
  const lastSeqRef = useRef(0);
  const reconnectingRef = useRef(false);
  const linesRef = useRef<ChatLine[]>([]);
  const hiddenSeqsRef = useRef<Set<number>>(new Set());
  const pressTimerRef = useRef<number | null>(null);

  const upsertLine = useCallback((incoming: ChatLine) => {
    setLines((prev) => {
      const next = redactHiddenReplies(mergeChatLines(prev, [incoming]), hiddenSeqsRef.current);
      lastSeqRef.current = lastKnownSeq(next);
      linesRef.current = next;
      return next;
    });
  }, []);

  function payloadToLine(raw: any): ChatLine {
    const replyTo = raw?.replyTo && typeof raw.replyTo === "object" ? raw.replyTo : null;
    return {
      clientMessageId: String(raw.clientMessageId),
      senderUserId: Number(raw.senderUserId || 0),
      sender: String(raw.sender || ""),
      senderRole: String(raw.senderRole || "caddy"),
      body: String(raw.body || ""),
      sentAt: String(raw.sentAt || ""),
      seq: Number(raw.seq) || undefined,
      mentions: mentionIdsFromPayload(raw.mentions),
      mentionAll: raw.mentionAll === true,
      replyToSeq: Number(raw.replyToSeq) || null,
      replyTo: replyTo
        ? {
            seq: Number(replyTo.seq || 0),
            senderUserId: Number(replyTo.senderUserId || 0),
            sender: String(replyTo.sender || ""),
            preview: String(replyTo.preview || ""),
            state: replyTo.state === "deleted" || replyTo.state === "expired" ? replyTo.state : "ok",
          }
        : null,
      deletionType: raw.deletionType === "admin" || raw.deletionType === "everyone" ? raw.deletionType : null,
      deletedAt: raw.deletedAt ? String(raw.deletedAt) : null,
      status: "sent",
    };
  }

  function clearTimer(ref: { current: number | null }) {
    if (ref.current != null) {
      window.clearTimeout(ref.current);
      ref.current = null;
    }
  }

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
    const visible = next.filter((r) => isVisibleChatListRoom(r.type));
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
    if (res.ok && Array.isArray(data?.rooms)) {
      applyRooms(data.rooms);
      setDirectorySnapshotReady(true);
    }
  }, [applyRooms]);

  const connectDirectoryRef = useRef<(info: TokenPayload) => void>(() => {});
  const connectSocketRef = useRef<(info: TokenPayload, roomId: string) => Promise<void>>(async () => {});

  const scheduleDirectoryReconnect = useCallback((info: TokenPayload) => {
    clearTimer(dirTimerRef);
    const delay = nextReconnectDelay(dirAttemptRef.current);
    dirAttemptRef.current += 1;
    dirTimerRef.current = window.setTimeout(() => {
      connectDirectoryRef.current(info);
    }, delay);
  }, []);

  const connectDirectory = useCallback(
    (info: TokenPayload) => {
      const url = chatDirectoryWsUrl(info.token);
      if (!url) return;
      const prev = dirRef.current;
      dirGenRef.current += 1;
      const gen = dirGenRef.current;
      if (prev && (prev.readyState === WebSocket.OPEN || prev.readyState === WebSocket.CONNECTING)) {
        prev.close();
      }
      const ws = new WebSocket(url);
      dirRef.current = ws;
      ws.addEventListener("open", () => {
        if (gen !== dirGenRef.current) return;
        setDirectoryConnected(true);
        dirAttemptRef.current = 0;
        try {
          ws.send(JSON.stringify({ type: "sync" }));
        } catch {
          // snapshot still arrives on connect
        }
      });
      ws.addEventListener("error", () => {
        if (gen !== dirGenRef.current) return;
        setDirectoryConnected(false);
        setDirectorySnapshotReady(false);
      });
      ws.addEventListener("close", (ev) => {
        if (gen !== dirGenRef.current) return;
        setDirectoryConnected(false);
        setDirectorySnapshotReady(false);
        const run = async () => {
          let next = info;
          if (shouldRefreshTokenOnClose(ev.code)) {
            const fresh = await fetchToken();
            if (!fresh) return;
            tokenRef.current = fresh;
            setTokenInfo(fresh);
            next = fresh;
          }
          scheduleDirectoryReconnect(next);
        };
        void run();
      });
      ws.addEventListener("message", (event) => {
        if (gen !== dirGenRef.current) return;
        let data: any;
        try {
          data = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if ((data.type === "rooms" || data.type === "room_summary") && Array.isArray(data.rooms)) {
          applyRooms(data.rooms);
          setDirectorySnapshotReady(true);
        }
      });
    },
    [applyRooms, fetchToken, scheduleDirectoryReconnect]
  );

  const scheduleRoomReconnect = useCallback((info: TokenPayload, roomId: string) => {
    clearTimer(roomTimerRef);
    const delay = nextReconnectDelay(roomAttemptRef.current);
    roomAttemptRef.current += 1;
    roomTimerRef.current = window.setTimeout(() => {
      void connectSocketRef.current(info, roomId);
    }, delay);
  }, []);

  const connectSocket = useCallback(
    async (info: TokenPayload, roomId: string) => {
      const url = chatWsUrl({ roomId, token: info.token });
      if (!url) {
        setError("채팅 서버 주소가 없습니다.");
        return;
      }
      const prev = wsRef.current;
      roomGenRef.current += 1;
      const gen = roomGenRef.current;
      if (prev && (prev.readyState === WebSocket.OPEN || prev.readyState === WebSocket.CONNECTING)) {
        prev.close();
      }
      const ws = new WebSocket(url);
      wsRef.current = ws;
      if (!reconnectingRef.current) {
        historyResetRef.current = true;
        oldestSeqRef.current = null;
        setHasMore(false);
      }
      ws.addEventListener("open", () => {
        if (gen !== roomGenRef.current) return;
        setConnected(true);
        setFailingSince(null);
        roomAttemptRef.current = 0;
        const afterSeq = lastSeqRef.current;
        if (reconnectingRef.current && afterSeq > 0) {
          try {
            ws.send(JSON.stringify({ type: "sync", afterSeq, limit: SYNC_LIMIT }));
          } catch {
            // history still arrives
          }
        } else {
          historyResetRef.current = true;
          reconnectingRef.current = false;
        }
      });
      ws.addEventListener("error", () => {
        if (gen !== roomGenRef.current) return;
        setConnected(false);
        setFailingSince((cur) => cur ?? Date.now());
      });
      ws.addEventListener("close", (ev) => {
        if (gen !== roomGenRef.current) return;
        setConnected(false);
        setFailingSince((cur) => cur ?? Date.now());
        setNowTick(Date.now());
        window.setTimeout(() => setNowTick(Date.now()), 15100);
        if (!roomRef.current) return;
        reconnectingRef.current = true;
        const run = async () => {
          let next = info;
          if (shouldRefreshTokenOnClose(ev.code)) {
            const fresh = await fetchToken();
            if (!fresh) return;
            tokenRef.current = fresh;
            setTokenInfo(fresh);
            connectDirectory(fresh);
            next = fresh;
          }
          const room = roomRef.current;
          if (room) scheduleRoomReconnect(next, room.roomId);
        };
        void run();
      });
      ws.addEventListener("message", (event) => {
        if (gen !== roomGenRef.current) return;
        let data: any;
        try {
          data = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (data.type === "history" && Array.isArray(data.messages)) {
          const hist = data.messages.map(payloadToLine);
          const reset = historyResetRef.current && !reconnectingRef.current;
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
            const next = redactHiddenReplies(hist, hiddenSeqsRef.current);
            setLines(next);
            linesRef.current = next;
            lastSeqRef.current = lastKnownSeq(next);
            const last = next[next.length - 1];
            if (last?.seq && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "read", seq: last.seq }));
            }
          } else if (!reconnectingRef.current) {
            const el = listRef.current;
            if (el) pendingScrollRestore.current = el.scrollHeight;
            setLines((prev) => {
              const next = redactHiddenReplies(mergeChatLines(hist, prev), hiddenSeqsRef.current);
              linesRef.current = next;
              lastSeqRef.current = lastKnownSeq(next);
              return next;
            });
          }
          return;
        }
        if (data.type === "sync" && Array.isArray(data.messages)) {
          const extra = data.messages.map(payloadToLine);
          setLines((prev) => {
            const next = redactHiddenReplies(mergeChatLines(prev, extra), hiddenSeqsRef.current);
            linesRef.current = next;
            lastSeqRef.current = lastKnownSeq(next);
            return next;
          });
          if (data.hasMore === true && ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: "sync",
                afterSeq: nextSyncCursor(data.newestSeq, extra.length ? Number(extra[extra.length - 1]!.seq) : 0),
                limit: SYNC_LIMIT,
              })
            );
          } else {
            reconnectingRef.current = false;
          }
          const last = extra[extra.length - 1];
          if (last?.seq && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "read", seq: last.seq }));
          }
          return;
        }
        if (data.type === "message") {
          const line = payloadToLine(data);
          if (!stickRef.current) setUnseenCount((n) => n + 1);
          upsertLine(line);
          if (line.seq && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "read", seq: line.seq }));
          }
          return;
        }
        if (data.type === "hidden" && Number(data.seq) > 0) {
          hiddenSeqsRef.current.add(Number(data.seq));
          setLines((prev) => {
            const next = applyHiddenSeq(prev, Number(data.seq));
            linesRef.current = next;
            return next;
          });
          return;
        }
        if (data.type === "message_deleted" && Number(data.seq) > 0) {
          setLines((prev) => {
            const next = applyDeletedLine(prev, {
              seq: Number(data.seq),
              deletionType: data.deletionType === "admin" ? "admin" : "everyone",
              deletedAt: String(data.deletedAt || new Date().toISOString()),
            });
            linesRef.current = next;
            return next;
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
    [connectDirectory, fetchToken, scheduleRoomReconnect, upsertLine]
  );

  connectDirectoryRef.current = connectDirectory;
  connectSocketRef.current = connectSocket;

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
        try {
          const prefRes = await fetch("/api/chat/notification-prefs", {
            credentials: "include",
            cache: "no-store",
          });
          const prefData = (await prefRes.json().catch(() => null)) as {
            prefs?: Record<string, ChatNotifyMode>;
          } | null;
          if (prefRes.ok && prefData?.prefs) setNotifyPrefs(prefData.prefs);
        } catch {
          // default ALL
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "채팅을 열 수 없습니다.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      roomGenRef.current += 1;
      dirGenRef.current += 1;
      clearTimer(roomTimerRef);
      clearTimer(dirTimerRef);
      wsRef.current?.close();
      dirRef.current?.close();
    };
  }, [connectDirectory, fetchRoomsHttp, fetchToken]);

  useEffect(() => {
    const reconnect = () => {
      const info = tokenRef.current;
      if (!info) return;
      connectDirectory(info);
      const room = roomRef.current;
      if (room) {
        reconnectingRef.current = true;
        void connectSocket(info, room.roomId);
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") reconnect();
    };
    window.addEventListener("online", reconnect);
    document.addEventListener("visibilitychange", onVisible);
    let removed = false;
    let appHandle: { remove: () => Promise<void> } | undefined;
    void import("@capacitor/app")
      .then(({ App }) => {
        if (removed) return;
        return App.addListener("appStateChange", ({ isActive }) => {
          if (isActive) reconnect();
        });
      })
      .then((handle) => {
        if (!handle) return;
        if (removed) {
          void handle.remove();
          return;
        }
        appHandle = handle;
      })
      .catch(() => undefined);
    return () => {
      removed = true;
      window.removeEventListener("online", reconnect);
      document.removeEventListener("visibilitychange", onVisible);
      void appHandle?.remove();
    };
  }, [connectDirectory, connectSocket]);

  useEffect(() => {
    const root = document.documentElement;
    const work = document.querySelector(".vh-work");
    const inner = document.querySelector(".vh-work-inner");
    root.classList.add("vh-chat-open");
    work?.classList.add("vh-chat-open");
    inner?.classList.add("vh-chat-open");
    return () => {
      root.classList.remove("vh-chat-open");
      work?.classList.remove("vh-chat-open");
      inner?.classList.remove("vh-chat-open");
    };
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const apply = () => {
      const vv = window.visualViewport;
      if (!vv) {
        root.style.setProperty("--vh-keyboard-inset", "0px");
        return;
      }
      const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      root.style.setProperty("--vh-keyboard-inset", `${Math.round(inset)}px`);
    };
    apply();
    window.visualViewport?.addEventListener("resize", apply);
    window.visualViewport?.addEventListener("scroll", apply);
    window.addEventListener("resize", apply);
    return () => {
      window.visualViewport?.removeEventListener("resize", apply);
      window.visualViewport?.removeEventListener("scroll", apply);
      window.removeEventListener("resize", apply);
      root.style.removeProperty("--vh-keyboard-inset");
    };
  }, []);

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
      reconnectingRef.current = false;
      roomGenRef.current += 1;
      clearTimer(roomTimerRef);
      wsRef.current?.close();
      setLines([]);
      setReplyTo(null);
      setActionLine(null);
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
    if (actionLine) {
      return registerAndroidChatOverlayClose(() => setActionLine(null));
    }
    if (profileTarget) {
      return registerAndroidChatOverlayClose(() => setProfileTarget(null));
    }
    if (mentionOpen) {
      return registerAndroidChatOverlayClose(() => setMentionSuppressed(true));
    }
    if (replyTo) {
      return registerAndroidChatOverlayClose(() => setReplyTo(null));
    }
    if (!sheet) return;
    return registerAndroidChatOverlayClose(() => setSheet(null));
  }, [actionLine, profileTarget, mentionOpen, replyTo, sheet]);

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
    setReplyTo(null);
    setActionLine(null);
    setProfileTarget(null);
    setUnseenCount(0);
    reconnectingRef.current = false;
    lastSeqRef.current = 0;
    linesRef.current = [];
    hiddenSeqsRef.current = new Set();
    if (mentionCacheRef.current?.roomId === room.roomId) {
      setMentionCandidates(mentionCacheRef.current.users);
    } else {
      setMentionCandidates([]);
      mentionFetchedRef.current = "";
    }
    await connectSocket(info, room.roomId);
  }

  useEffect(() => {
    const requested =
      parseChatDeepLinkRoomId(
        typeof window !== "undefined"
          ? new URLSearchParams(window.location.search).get("room")
          : null
      ) || readPendingChatRoomId(typeof sessionStorage === "undefined" ? null : sessionStorage);
    const action = resolveChatDeepLinkAction({
      requestedRoomId: requested,
      rooms,
      directorySnapshotReady,
    });
    if (action === "none" || !requested) return;
    if (action === "wait") return;
    if (deepLinkTriedRef.current === requested) return;
    deepLinkTriedRef.current = requested;
    if (action === "fallback") {
      clearPendingChatRoomId(typeof sessionStorage === "undefined" ? null : sessionStorage);
      setError("참여할 수 없는 채팅방입니다.");
      setView("list");
      return;
    }
    const room = rooms.find((row) => row.roomId === requested);
    if (!room) return;
    clearPendingChatRoomId(typeof sessionStorage === "undefined" ? null : sessionStorage);
    void openRoom(room);
  }, [directorySnapshotReady, rooms]);

  async function saveNotifyMode(mode: ChatNotifyMode) {
    const room = activeRoom;
    if (!room) return;
    const prev = notifyPrefs[room.roomId] ?? DEFAULT_CHAT_NOTIFY_MODE;
    setNotifyPrefs((cur) => ({ ...cur, [room.roomId]: mode }));
    const res = await fetch(
      `/api/chat/rooms/${encodeURIComponent(room.roomId)}/notification`,
      {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      }
    );
    if (await consumeUnauthorizedMemberResponse(res)) return;
    if (!res.ok) {
      setNotifyPrefs((cur) => ({ ...cur, [room.roomId]: prev }));
      setError("알림 설정을 저장하지 못했습니다.");
      return;
    }
    setSheet(null);
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
    mentionAll = mentionAllDraft,
    replyToSeq?: number | null
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
        mentionAll: isDmRoomId(room.roomId) ? false : mentionAll,
        replyToSeq: replyToSeq || undefined,
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
    const reply = replyTo;
    setReplyTo(null);
    setSending(true);
    upsertLine({
      clientMessageId,
      senderUserId: tokenInfo.user.userId,
      sender: tokenInfo.user.displayName,
      senderRole: tokenInfo.user.role,
      body,
      sentAt: new Date().toISOString(),
      mentions: tokens.map((t) => t.userId),
      mentionAll: isDmRoomId(roomRef.current?.roomId || "") ? false : mentionAll,
      replyToSeq: reply?.seq || null,
      replyTo: reply,
      status: "sending",
    });
    try {
      await sendCurrent(body, clientMessageId, tokens, mentionAll, reply?.seq);
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
    reconnectingRef.current = lastSeqRef.current > 0;
    roomAttemptRef.current = 0;
    await connectSocket(info, room.roomId);
  }

  function jumpToBottom() {
    const el = listRef.current;
    if (!el) return;
    stickRef.current = true;
    setUnseenCount(0);
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }

  async function startDm(peer: ProfileTarget) {
    setError("");
    const res = await fetch("/api/chat/dm", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ peerUserId: peer.userId }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      setError(data?.message || "1:1 채팅을 시작하지 못했습니다.");
      return;
    }
    setProfileTarget(null);
    const room = data?.room;
    if (!room?.roomId) return;
    const optimistic = {
      roomId: String(room.roomId),
      name: String(room.name || peer.displayName),
      type: "DM" as const,
      ownerUserId: Number(room.ownerUserId || tokenInfo?.user.userId || 0),
      memberCount: 2,
      lastMessageSeq: 0,
      lastMessagePreview: "",
      lastMessageAt: null,
      lastSenderName: null,
      lastSenderRole: null,
      unread: 0,
      createdAt: new Date().toISOString(),
      peerUserId: Number(room.peerUserId || peer.userId),
      peerDisplayName: String(room.peerDisplayName || peer.displayName),
      peerRole: String(room.peerRole || peer.role),
      peerTeam: String(room.peerTeam || peer.team || "-"),
    };
    setRooms((prev) => upsertVisibleChatRoom(prev, optimistic));
    try {
      await openRoom(optimistic);
      const info = tokenRef.current;
      if (info) await fetchRoomsHttp(info.token);
    } catch {
      setRooms((prev) => rollbackOptimisticChatRoom(prev, optimistic.roomId));
      setError("1:1 채팅을 열지 못했습니다.");
    }
  }

  function openActions(line: ChatLine) {
    if (!line.seq) return;
    setNowTick(Date.now());
    setActionLine(line);
  }

  function startReply(line: ChatLine) {
    if (!line.seq || line.deletionType) return;
    setReplyTo({
      seq: line.seq,
      senderUserId: line.senderUserId,
      sender: line.sender,
      preview: line.body.slice(0, 80),
      state: "ok",
    });
    setActionLine(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function sendHide(seq: number) {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "hide", seq }));
    setActionLine(null);
  }

  function sendDelete(seq: number, mode: "everyone" | "admin") {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "delete", seq, mode }));
    setActionLine(null);
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
        canMentionAll:
          canMentionAll(tokenInfo?.user.role) && !isDmRoomId(activeRoom?.roomId || ""),
      })
    : [];
  const inviteCandidates = invitePoolExcludingOwner(invitePool, ownerUserId);
  const visibleInviteUsers = filterInviteUsers(inviteCandidates, userQuery);
  const inviteTeams = visibleInviteTeams(inviteCandidates);
  const inviteRoles = visibleInviteRoles(inviteCandidates);
  const selectedCount = inviteSelectionCount(selectedIds);
  const linkStatus = chatReconnectStatus({
    connected: view === "room" ? connected : directoryConnected,
    failingSinceMs: failingSince,
    nowMs: nowTick,
  });

  return (
    <div className={`vh-chat ${view === "room" ? "is-room" : "is-list"}`}>
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
            {rooms.map((room) => {
              const title = roomListTitle(room);
              return (
              <button
                key={room.roomId}
                type="button"
                className={`vh-chat-room-card ${room.type === "ALL" ? "is-all" : ""} ${room.type === "DM" ? "is-dm" : ""}`}
                onClick={() => void openRoom(room)}
              >
                <span className={`vh-chat-avatar ${room.type === "ALL" ? "is-all" : ""}`} aria-hidden="true">
                  {room.type === "ALL" ? "전" : defaultAvatarInitial(title)}
                </span>
                <div className="vh-chat-room-card-main">
                <div className="vh-chat-room-card-top">
                  <div className="vh-chat-room-card-name">
                    {title}
                    {notifyPrefs[room.roomId] === "OFF" ? (
                      <span className="vh-chat-notify-off" aria-label="알림 끔">
                        {" "}
                        🔕
                      </span>
                    ) : notifyPrefs[room.roomId] === "MENTIONS" ? (
                      <span className="vh-chat-notify-mentions" aria-label="멘션만">
                        {" "}
                        @
                      </span>
                    ) : null}
                  </div>
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
                </div>
              </button>
              );
            })}
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
                reconnectingRef.current = false;
                roomGenRef.current += 1;
                clearTimer(roomTimerRef);
                wsRef.current?.close();
                setLines([]);
                setReplyTo(null);
                setActionLine(null);
                setProfileTarget(null);
              }}
            >
              목록
            </button>
            <button
              type="button"
              className="vh-chat-room-title-btn"
              onClick={() => {
                if (activeRoom?.type === "DM" && activeRoom.peerUserId) {
                  setProfileTarget({
                    userId: activeRoom.peerUserId,
                    displayName: activeRoom.peerDisplayName || activeRoom.name,
                    team: activeRoom.peerTeam || "-",
                    role: activeRoom.peerRole || "caddy",
                  });
                  return;
                }
                void openMembers();
              }}
            >
              <h1 className="vh-chat-room-title">{activeRoom ? roomListTitle(activeRoom) : "채팅"}</h1>
              {activeRoom && activeRoom.type === "CUSTOM" ? (
                <span className="vh-chat-member-count">{activeRoom.memberCount}명</span>
              ) : null}
            </button>
            <button
              type="button"
              className="vh-chat-notify-btn"
              onClick={() => setSheet("notify")}
            >
              알림
            </button>
            {linkStatus === "reconnecting" ? (
              <span className="vh-chat-dot">재연결 중…</span>
            ) : linkStatus === "failed" ? (
              <span className="vh-chat-dot">끊김</span>
            ) : (
              <span className="vh-chat-dot is-on" aria-hidden="true" />
            )}
          </div>
          {error ? <p className="vh-chat-error">{error}</p> : null}
          <div
            ref={listRef}
            className="vh-chat-log"
            onScroll={(e) => {
              const el = e.currentTarget;
              const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
              stickRef.current = nearBottom;
              if (nearBottom) setUnseenCount(0);
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
            {lines.map((line, index) => {
              const mine = tokenInfo ? line.senderUserId === tokenInfo.user.userId : false;
              const admin = line.senderRole === "admin";
              const deleted = Boolean(line.deletionType);
              const prev = lines[index - 1];
              const showDate = shouldShowDateDivider(prev?.sentAt, line.sentAt);
              const showAuthor = shouldShowAuthorMeta({
                mine,
                deleted,
                prevSenderUserId: prev?.senderUserId,
                senderUserId: line.senderUserId,
                prevSentAt: prev?.sentAt,
                sentAt: line.sentAt,
              });
              const selfMentioned =
                !deleted &&
                isSelfMentioned({
                  myUserId: tokenInfo?.user.userId,
                  mentions: line.mentions,
                  mentionAll: line.mentionAll,
                  senderUserId: line.senderUserId,
                });
              const nameByUserId = new Map<number, string>(mentionNamesRef.current);
              for (const c of mentionCandidates) nameByUserId.set(c.userId, c.displayName);
              for (const m of members) nameByUserId.set(m.userId, m.displayName);
              for (const token of mentionTokens) {
                if (token.label) nameByUserId.set(token.userId, token.label);
              }
              const parts = deleted
                ? []
                : splitMentionBody(line.body, {
                    mentions: line.mentions,
                    mentionAll: line.mentionAll,
                    nameByUserId,
                  });
              const authorLine = chatAuthorLine({
                displayName: line.sender,
                team: line.senderUserId === activeRoom?.peerUserId ? activeRoom.peerTeam : undefined,
                role: line.senderRole,
              });
              return (
                <div key={line.clientMessageId}>
                  {showDate ? (
                    <div className="vh-chat-date">{formatChatDateDivider(line.sentAt)}</div>
                  ) : null}
                  {deleted ? (
                    <div className="vh-chat-tombstone" data-chat-seq={line.seq || undefined}>
                      {displayTombstone(line.deletionType)}
                    </div>
                  ) : (
                <div
                  className={`vh-chat-row ${mine ? "is-mine" : "is-theirs"} ${showAuthor ? "is-lead" : "is-follow"}`}
                  data-chat-seq={line.seq || undefined}
                >
                  {!mine ? (
                    showAuthor ? (
                      <button
                        type="button"
                        className="vh-chat-avatar"
                        onClick={() =>
                          setProfileTarget({
                            userId: line.senderUserId,
                            displayName: line.sender,
                            team: line.senderUserId === activeRoom?.peerUserId ? activeRoom.peerTeam || "-" : "-",
                            role: line.senderRole,
                          })
                        }
                      >
                        {defaultAvatarInitial(line.sender)}
                      </button>
                    ) : (
                      <span className="vh-chat-avatar is-spacer" aria-hidden="true" />
                    )
                  ) : null}
                  <div
                  className={`vh-chat-bubble ${mine ? "is-mine" : "is-theirs"} ${admin ? "is-admin" : ""}`}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    openActions(line);
                  }}
                  onPointerDown={() => {
                    if (pressTimerRef.current != null) window.clearTimeout(pressTimerRef.current);
                    pressTimerRef.current = window.setTimeout(() => openActions(line), 420);
                  }}
                  onPointerUp={() => {
                    if (pressTimerRef.current != null) window.clearTimeout(pressTimerRef.current);
                    pressTimerRef.current = null;
                  }}
                  onPointerLeave={() => {
                    if (pressTimerRef.current != null) window.clearTimeout(pressTimerRef.current);
                    pressTimerRef.current = null;
                  }}
                >
                  {showAuthor ? (
                    <button
                      type="button"
                      className="vh-chat-name"
                      onClick={() =>
                        setProfileTarget({
                          userId: line.senderUserId,
                          displayName: line.sender,
                          team: line.senderUserId === activeRoom?.peerUserId ? activeRoom.peerTeam || "-" : "-",
                          role: line.senderRole,
                        })
                      }
                    >
                      {authorLine}
                      {admin ? <span className="vh-chat-admin-badge">관리자</span> : null}
                      {line.senderRole === "leader" ? <span className="vh-chat-role-badge">조장</span> : null}
                    </button>
                  ) : null}
                  {selfMentioned ? <div className="vh-chat-mention-self">@ 나를 멘션</div> : null}
                  {line.replyTo ? (
                    <button
                      type="button"
                      className={`vh-chat-reply ${line.replyTo.state !== "ok" ? "is-gone" : ""}`}
                      onClick={() => {
                        if (!jumpToMessageIfMounted({ seq: line.replyTo!.seq, root: listRef.current })) {
                          setError("원 메시지가 현재 화면에 없습니다.");
                        }
                      }}
                    >
                      <strong>{line.replyTo.state === "ok" ? line.replyTo.sender : "답장"}</strong>
                      <span>{line.replyTo.preview}</span>
                    </button>
                  ) : null}
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
                </div>
                  )}
                </div>
              );
            })}
          </div>
          {shouldShowJumpButton({ stuckToBottom: stickRef.current, unseenCount }) ? (
            <button type="button" className="vh-chat-jump" onClick={jumpToBottom}>
              ↓ 새 메시지{unseenCount > 1 ? ` ${unseenCount > 99 ? "99+" : unseenCount}` : ""}
            </button>
          ) : null}
          <form
            className="vh-chat-composer"
            onSubmit={(e) => {
              e.preventDefault();
              void handleSend();
            }}
          >
            {replyTo ? (
              <div className="vh-chat-reply-draft">
                <div>
                  <strong>{replyTo.sender}</strong>
                  <span>{replyTo.preview}</span>
                </div>
                <button type="button" className="vh-chat-back" onClick={() => setReplyTo(null)}>
                  X
                </button>
              </div>
            ) : null}
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
          {linkStatus === "failed" ? (
            <button type="button" className="vh-chat-reconnect" onClick={() => void handleReconnect()}>
              다시 시도
            </button>
          ) : null}
        </>
      )}

      {actionLine ? (
        <div className="vh-chat-action-scrim" onClick={() => setActionLine(null)}>
          <div
            className="vh-chat-action-menu"
            role="menu"
            onClick={(e) => e.stopPropagation()}
          >
            {chatActionItems({
              myUserId: tokenInfo?.user.userId,
              myRole: tokenInfo?.user.role,
              senderUserId: actionLine.senderUserId,
              sentAt: actionLine.sentAt,
              deletionType: actionLine.deletionType,
              nowMs: nowTick,
            }).map((item) => (
              <button
                key={item}
                type="button"
                className="vh-chat-action-item"
                onClick={() => {
                  if (item === "reply" && actionLine.seq) startReply(actionLine);
                  if (item === "hide" && actionLine.seq) sendHide(actionLine.seq);
                  if (item === "delete-everyone" && actionLine.seq) sendDelete(actionLine.seq, "everyone");
                  if (item === "delete-admin" && actionLine.seq) sendDelete(actionLine.seq, "admin");
                }}
              >
                {item === "reply"
                  ? "답장"
                  : item === "hide"
                    ? "나에게서만 삭제"
                    : item === "delete-everyone"
                      ? "모두에게서 삭제"
                      : "관리자 삭제"}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {profileTarget ? (
        <div className="vh-chat-sheet vh-chat-profile-sheet" role="dialog" aria-label="프로필">
          <div className="vh-chat-sheet-head">
            <strong>프로필</strong>
            <button type="button" className="vh-chat-back" onClick={() => setProfileTarget(null)}>
              닫기
            </button>
          </div>
          <div className="vh-chat-sheet-body">
            {(() => {
              const profile = publicChatProfile(profileTarget);
              return (
                <>
                  <div className="vh-chat-avatar is-lg" aria-hidden="true">
                    {defaultAvatarInitial(profile.displayName)}
                  </div>
                  <p className="vh-chat-profile-name">{profile.authorLine}</p>
                  <p className="vh-chat-profile-role">{profile.roleLabel}</p>
                </>
              );
            })()}
          </div>
          <div className="vh-chat-sheet-foot">
            {tokenInfo && profileTarget.userId !== tokenInfo.user.userId ? (
              <button type="button" className="ui-btn ui-btn-primary" onClick={() => void startDm(profileTarget)}>
                1:1 채팅
              </button>
            ) : null}
            {tokenInfo &&
            canProfileMention({
              roomId: activeRoom?.roomId,
              isMember:
                mentionCandidates.some((c) => c.userId === profileTarget.userId) ||
                members.some((m) => m.userId === profileTarget.userId) ||
                activeRoom?.type === "ALL",
              targetUserId: profileTarget.userId,
              myUserId: tokenInfo.user.userId,
            }) ? (
              <button
                type="button"
                className="ui-btn"
                onClick={() => {
                  pickMention({
                    kind: "user",
                    userId: profileTarget.userId,
                    displayName: profileTarget.displayName,
                  });
                  setProfileTarget(null);
                }}
              >
                @멘션
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

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

      {sheet === "notify" ? (
        <div className="vh-chat-sheet" role="dialog" aria-label="알림 설정">
          <div className="vh-chat-sheet-head">
            <strong>알림 설정</strong>
            <button type="button" className="vh-chat-back" onClick={() => setSheet(null)}>
              닫기
            </button>
          </div>
          <div className="vh-chat-notify-choices">
            {(
              [
                ["ALL", "모든 알림"],
                ["MENTIONS", "멘션만"],
                ["OFF", "알림 끄기"],
              ] as const
            ).map(([mode, label]) => {
              const current = (activeRoom && notifyPrefs[activeRoom.roomId]) || DEFAULT_CHAT_NOTIFY_MODE;
              return (
                <button
                  key={mode}
                  type="button"
                  className={`vh-chat-notify-choice ${current === mode ? "is-on" : ""}`}
                  onClick={() => void saveNotifyMode(mode)}
                >
                  <span className="vh-chat-notify-radio" aria-hidden="true">
                    {current === mode ? "●" : "○"}
                  </span>
                  {label}
                </button>
              );
            })}
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
