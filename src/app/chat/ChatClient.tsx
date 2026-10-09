"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  registerAndroidChatOverlayClose,
  registerAndroidChatRoomLeave,
} from "@/lib/androidSystemBack";
import {
  chatDirectoryMembersUrl,
  chatDirectoryRoomUrl,
  chatDirectoryRoomsUrl,
  chatDirectoryWsUrl,
  chatWsUrl,
  warmChatPhotoMediaConnection,
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
  replyPreviewFromBody,
  SYNC_LIMIT,
  type ChatLineReply,
} from "@/lib/chatPhase4";
import type { ChatAttachment } from "../../../cloudflare/verthill-chat/src/protocol";
import {
  abandonChatPhotoPreupload,
  appendComposerPhotos,
  applyChatPhotoSendProgress,
  applyComposerPreparedIfCurrent,
  applyComposerProgressIfCurrent,
  buildOptimisticOutgoingLine,
  CHAT_PHOTO_ACCEPT,
  CHAT_PHOTO_MAX,
  chatPhotoComposerBusy,
  chatPhotoSrc,
  commitComposerPhotoPicks,
  finishChatPhotoOutgoingUploads,
  leftoverComposerPhotosAfterSend,
  needsChatPhotoHeavyPrepare,
  outgoingChatPhotoSrc,
  prepareChatPendingPhoto,
  revokeChatPhotoPreviewUrls,
  shouldStartOptimisticChatSend,
  startChatPhotoPreupload,
  usableOptimisticChatPhotos,
  visibleComposerPhotos,
  type ChatPendingPhoto,
} from "@/lib/chatPhotoClient";
import {
  buildChatPhotoDebugSample,
  canShowChatPhotoDebug,
  chatPhotoNow,
  emitChatPhotoTimingSummary,
  markChatPhotoTiming,
  noteChatPhotoBytes,
  noteChatPhotoCompression,
  resetChatPhotoTiming,
  stampChatPhotoTiming,
  type ChatPhotoDebugSample,
} from "@/lib/chatPhotoTiming";
import type { ChatPhotoDirectProgress, ChatPhotoDirectResult } from "@/lib/chatPhotoDirectClient";
import {
  canProfileMention,
  chatAuthorLine,
  chatRoleLabel,
  defaultAvatarInitial,
  formatChatDateDivider,
  isVisibleChatListRoom,
  isNearChatBottom,
  jumpToMessageIfMounted,
  publicChatProfile,
  roomListTitle,
  shouldShowAuthorMeta,
  shouldShowDateDivider,
  shouldShowJumpButton,
} from "@/lib/chatPhase5";
import {
  CHAT_UNREAD_SPLIT_LABEL,
  applyChatEntryScroll,
  firstLoadedSeqAtOrAfter,
  resolveChatEntryTarget,
  shouldAutoLoadOlderOnScroll,
  shouldFollowIncomingMessage,
  shouldReapplyPinnedEntryScroll,
  shouldRequestOlderForTarget,
  shouldShowUnreadSplit,
  snapshotChatEntry,
  parseChatTargetSeqFromRoomUrl,
  type ChatEntryPin,
  type ChatEntrySnapshot,
  type ChatEntryTarget,
} from "@/lib/chatScroll";
import {
  clearPendingChatRoomId,
  nextDirectorySnapshotReady,
  parseChatDeepLinkRoomId,
  readPendingChatRoomId,
  resolveChatDeepLinkAction,
  resolveDirectoryHttpRoomsApply,
  resolveTargetedRoomResponse,
  rollbackOptimisticChatRoom,
  upsertVisibleChatRoom,
  type ChatDeepLinkTargetedStatus,
} from "@/lib/chatPhase6";
import {
  chatNotifyHeaderAriaLabel,
  chatNotifyHeaderLabel,
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
  nextDmMentionState,
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
  attachments?: ChatAttachment[];
  pendingClaims?: Array<ChatAttachment & { exp: number; claim: string }>;
  localPhotos?: ChatPendingPhoto[];
  replyToSeq?: number | null;
  replyTo?: ChatLineReply | null;
  deletionType?: "everyone" | "admin" | null;
  deletedAt?: string | null;
  status: "sending" | "sent" | "failed";
};

type PendingChatPhoto = ChatPendingPhoto;

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
  const [targetedRoom, setTargetedRoom] = useState<RoomSummary | null>(null);
  const [targetedStatus, setTargetedStatus] = useState<ChatDeepLinkTargetedStatus>("idle");
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
  const sendingRef = useRef(new Set<string>());
  const [createName, setCreateName] = useState("");
  const [userQuery, setUserQuery] = useState("");
  const [invitePool, setInvitePool] = useState<SearchHit[]>([]);
  const [inviteLoading, setInviteLoading] = useState(false);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [creating, setCreating] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [pendingPhotos, setPendingPhotos] = useState<PendingChatPhoto[]>([]);
  const pendingPhotosRef = useRef<PendingChatPhoto[]>([]);
  const composerGenRef = useRef(0);
  const prepareJobsRef = useRef(new Map<string, Promise<ChatPendingPhoto>>());
  const uploadJobsRef = useRef(new Map<string, Promise<ChatPhotoDirectResult>>());
  const [photoDebug, setPhotoDebug] = useState(false);
  const [photoDebugSample, setPhotoDebugSample] = useState<ChatPhotoDebugSample | null>(null);
  const [lightbox, setLightbox] = useState<{ src: string } | null>(null);
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
  const hasMoreRef = useRef(false);
  const entrySnapshotRef = useRef<ChatEntrySnapshot | null>(null);
  const entryTargetRef = useRef<ChatEntryTarget | null>(null);
  const entrySeekRef = useRef(false);
  const entryPinRef = useRef<ChatEntryPin | null>(null);
  const entryPagesRef = useRef(0);
  const userMovedScrollRef = useRef(false);
  const programmaticScrollRef = useRef(false);
  const createReqRef = useRef("");
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const photoInputRef = useRef<HTMLInputElement | null>(null);
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
      const prevMatch = prev.find((row) => row.clientMessageId === incoming.clientMessageId);
      if (
        incoming.status === "sent" &&
        incoming.attachments &&
        incoming.attachments.length > 0 &&
        prevMatch?.localPhotos?.length
      ) {
        revokeChatPhotoPreviewUrls(prevMatch.localPhotos);
        incoming = { ...incoming, localPhotos: undefined };
      }
      const next = redactHiddenReplies(mergeChatLines(prev, [incoming]), hiddenSeqsRef.current);
      lastSeqRef.current = lastKnownSeq(next);
      linesRef.current = next;
      return next;
    });
  }, []);

  function patchOutgoingLine(clientMessageId: string, patch: (line: ChatLine) => ChatLine) {
    setLines((prev) => {
      const next = prev.map((line) => (line.clientMessageId === clientMessageId ? patch(line) : line));
      linesRef.current = next;
      return next;
    });
  }

  function clearLocalLines(next: ChatLine[] = []) {
    for (const line of linesRef.current) {
      if (line.localPhotos?.length) revokeChatPhotoPreviewUrls(line.localPhotos);
    }
    linesRef.current = next;
    setLines(next);
  }

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
      attachments: Array.isArray(raw.attachments)
        ? raw.attachments
            .map((item: unknown) => {
              if (!item || typeof item !== "object") return null;
              const rec = item as Record<string, unknown>;
              const id = String(rec.id || "").trim();
              const mimeType = String(rec.mimeType || "").trim();
              const size = Number(rec.size);
              if (!id || !mimeType || !Number.isInteger(size) || size <= 0) return null;
              return { id, mimeType, size };
            })
            .filter(Boolean) as ChatAttachment[]
        : [],
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
      const match = visible.find((r) => r.roomId === cur.roomId);
      if (!match) return cur;
      if (roomRef.current?.roomId === match.roomId) {
        roomRef.current = match;
      }
      return match;
    });
  }, []);

  const fetchTargetedRoom = useCallback(async (token: string, roomId: string) => {
    const url = chatDirectoryRoomUrl(roomId, token);
    if (!url) {
      setTargetedStatus("error");
      return;
    }
    setTargetedStatus("loading");
    try {
      const res = await fetch(url, { cache: "no-store" });
      const data = (await res.json().catch(() => null)) as { room?: RoomSummary } | null;
      const resolved = resolveTargetedRoomResponse({
        httpStatus: res.status,
        requestedRoomId: roomId,
        body: data,
      });
      if (resolved.status === "ready" && data?.room) {
        setTargetedRoom(data.room);
        setRooms((prev) => upsertVisibleChatRoom(prev, data.room as RoomSummary));
      }
      setTargetedStatus(resolved.status);
    } catch {
      setTargetedStatus("error");
    }
  }, []);

  const fetchRoomsHttp = useCallback(async (token: string) => {
    const url = chatDirectoryRoomsUrl(token);
    if (!url) return;
    const startedGen = dirGenRef.current;
    const res = await fetch(url, { cache: "no-store" });
    const data = await res.json().catch(() => null);
    if (
      resolveDirectoryHttpRoomsApply({
        startedGen,
        currentGen: dirGenRef.current,
        ok: res.ok,
        rooms: data?.rooms,
      }) !== "apply"
    ) {
      return;
    }
    applyRooms(data.rooms);
    setDirectorySnapshotReady(nextDirectorySnapshotReady(false, "authoritative_rooms"));
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
      setDirectorySnapshotReady(nextDirectorySnapshotReady(true, "connect_start"));
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
        setDirectorySnapshotReady(nextDirectorySnapshotReady(true, "socket_error"));
      });
      ws.addEventListener("close", (ev) => {
        if (gen !== dirGenRef.current) return;
        setDirectoryConnected(false);
        setDirectorySnapshotReady(nextDirectorySnapshotReady(true, "socket_close"));
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
          setDirectorySnapshotReady(nextDirectorySnapshotReady(false, "authoritative_rooms"));
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
          hasMoreRef.current = data.hasMore === true;
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
            queueEntrySeek(next);
          } else if (!reconnectingRef.current) {
            const el = listRef.current;
            if (el) pendingScrollRestore.current = el.scrollHeight;
            setLines((prev) => {
              const next = redactHiddenReplies(mergeChatLines(hist, prev), hiddenSeqsRef.current);
              linesRef.current = next;
              lastSeqRef.current = lastKnownSeq(next);
              queueEntrySeek(next);
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
          if (!shouldFollowIncomingMessage({ stuckToBottom: stickRef.current })) {
            setUnseenCount((n) => n + 1);
          }
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
        warmChatPhotoMediaConnection();
        warmChatPhotoMediaConnection();
        const requested =
          parseChatDeepLinkRoomId(new URLSearchParams(window.location.search).get("room")) ||
          readPendingChatRoomId(sessionStorage);
        connectDirectory(info);
        if (requested) {
          void fetchTargetedRoom(info.token, requested);
        }
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
  }, [connectDirectory, fetchRoomsHttp, fetchTargetedRoom, fetchToken]);

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
    setPhotoDebug(
      canShowChatPhotoDebug({
        role: tokenInfo?.user.role,
        search: typeof window !== "undefined" ? window.location.search : "",
      })
    );
  }, [tokenInfo?.user.role]);

  function refreshPhotoDebugSample() {
    if (!photoDebug) return;
    setPhotoDebugSample(buildChatPhotoDebugSample());
  }

  function applyPinnedEntryScroll() {
    const el = listRef.current;
    if (!el) return;
    const pin = entryPinRef.current;
    programmaticScrollRef.current = true;
    if (shouldReapplyPinnedEntryScroll({ userMoved: userMovedScrollRef.current, pin })) {
      applyChatEntryScroll(el, pin!);
    } else if (stickRef.current) {
      el.scrollTop = el.scrollHeight;
    }
    requestAnimationFrame(() => {
      programmaticScrollRef.current = false;
    });
  }

  function queueEntrySeek(nextLines: ChatLine[]) {
    const target = entryTargetRef.current;
    if (!target || !entrySeekRef.current) return;
    if (target.kind === "bottom" || target.seq == null) {
      entrySeekRef.current = false;
      entryPinRef.current = { kind: "bottom", seq: null };
      stickRef.current = true;
      return;
    }
    const found = firstLoadedSeqAtOrAfter(nextLines, target.seq);
    if (found != null) {
      entrySeekRef.current = false;
      entryPinRef.current = { kind: "seq", seq: found };
      stickRef.current = false;
      return;
    }
    if (
      shouldRequestOlderForTarget({
        targetSeq: target.seq,
        oldestLoadedSeq: oldestSeqRef.current,
        hasMore: hasMoreRef.current,
        pages: entryPagesRef.current,
      })
    ) {
      entryPagesRef.current += 1;
      requestOlderHistory();
      return;
    }
    entrySeekRef.current = false;
    entryPinRef.current = {
      kind: "seq",
      seq: nextLines[0]?.seq || null,
    };
    stickRef.current = false;
  }

  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el || view !== "room") return;
    if (pendingScrollRestore.current != null) {
      el.scrollTop = el.scrollHeight - pendingScrollRestore.current;
      pendingScrollRestore.current = null;
    }
    applyPinnedEntryScroll();
  }, [lines, view]);

  useEffect(() => {
    if (view !== "room") return;
    return registerAndroidChatRoomLeave(() => {
      setView("list");
      setActiveRoom(null);
      roomRef.current = null;
      entrySeekRef.current = false;
      entryPinRef.current = null;
      entrySnapshotRef.current = null;
      entryTargetRef.current = null;
      reconnectingRef.current = false;
      roomGenRef.current += 1;
      clearTimer(roomTimerRef);
      wsRef.current?.close();
      abandonComposerPhotos();
      clearLocalLines([]);
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
    if (isDmRoomId(room.roomId)) {
      const next = nextDmMentionState({
        roomId: room.roomId,
        myUserId: info.user.userId,
        peerUserId: room.peerUserId,
        peerDisplayName: room.peerDisplayName,
        peerRole: room.peerRole,
        peerTeam: room.peerTeam,
        cache: mentionCacheRef.current,
      });
      mentionCacheRef.current = next.cache;
      for (const user of next.users) {
        if (user.displayName) mentionNamesRef.current.set(user.userId, user.displayName);
      }
      setMentionCandidates(next.users);
      setMentionLoading(false);
      return;
    }
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
    const room = activeRoom;
    const info = tokenRef.current;
    if (!room || !info || !isDmRoomId(room.roomId)) return;
    if (roomRef.current?.roomId === room.roomId) {
      roomRef.current = room;
    }
    const next = nextDmMentionState({
      roomId: room.roomId,
      myUserId: info.user.userId,
      peerUserId: room.peerUserId,
      peerDisplayName: room.peerDisplayName,
      peerRole: room.peerRole,
      peerTeam: room.peerTeam,
      cache: mentionCacheRef.current,
    });
    mentionCacheRef.current = next.cache;
    if (next.reused) return;
    for (const user of next.users) {
      if (user.displayName) mentionNamesRef.current.set(user.userId, user.displayName);
    }
    setMentionCandidates(next.users);
  }, [activeRoom]);

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

  async function openRoom(room: RoomSummary, opts?: { targetSeq?: number | null }) {
    const info = await refreshIfNeeded();
    if (!info) return;
    const urlSeq =
      typeof window !== "undefined"
        ? parseChatTargetSeqFromRoomUrl(room.roomId, window.location.search)
        : null;
    const snapshot = snapshotChatEntry({
      unread: room.unread,
      lastMessageSeq: room.lastMessageSeq,
      explicitSeq: opts?.targetSeq ?? urlSeq,
    });
    entrySnapshotRef.current = snapshot;
    entryTargetRef.current = resolveChatEntryTarget(snapshot);
    entrySeekRef.current = true;
    entryPinRef.current = null;
    entryPagesRef.current = 0;
    userMovedScrollRef.current = false;
    stickRef.current = entryTargetRef.current.kind === "bottom";
    roomRef.current = room;
    setActiveRoom(room);
    setView("room");
    clearLocalLines([]);
    pendingScrollRestore.current = null;
    loadingOlderRef.current = false;
    setLoadingOlder(false);
    hasMoreRef.current = false;
    setHasMore(false);
    setError("");
    setDraft("");
    setMentionTokens([]);
    setMentionAllDraft(false);
    setMentionSuppressed(false);
    abandonComposerPhotos();
    setReplyTo(null);
    setActionLine(null);
    setProfileTarget(null);
    setUnseenCount(0);
    reconnectingRef.current = false;
    lastSeqRef.current = 0;
    linesRef.current = [];
    hiddenSeqsRef.current = new Set();
    if (isDmRoomId(room.roomId)) {
      const next = nextDmMentionState({
        roomId: room.roomId,
        myUserId: info.user.userId,
        peerUserId: room.peerUserId,
        peerDisplayName: room.peerDisplayName,
        peerRole: room.peerRole,
        peerTeam: room.peerTeam,
        cache: mentionCacheRef.current,
      });
      mentionCacheRef.current = next.cache;
      for (const user of next.users) {
        if (user.displayName) mentionNamesRef.current.set(user.userId, user.displayName);
      }
      setMentionCandidates(next.users);
    } else if (mentionCacheRef.current?.roomId === room.roomId) {
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
      targetedRoom,
      targetedStatus,
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
    const room =
      rooms.find((row) => row.roomId === requested) ||
      (targetedRoom?.roomId === requested ? targetedRoom : null);
    if (!room) return;
    clearPendingChatRoomId(typeof sessionStorage === "undefined" ? null : sessionStorage);
    const targetSeq =
      typeof window !== "undefined"
        ? parseChatTargetSeqFromRoomUrl(room.roomId, window.location.search)
        : null;
    void openRoom(room, { targetSeq });
  }, [directorySnapshotReady, rooms, targetedRoom, targetedStatus]);

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
    if (!hasMoreRef.current || loadingOlderRef.current) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    ws.send(JSON.stringify({ type: "history", beforeSeq, limit: 30 }));
  }

  async function sendCurrent(
    body: string,
    clientMessageId: string,
    tokens: ComposerMention[] = mentionTokens,
    mentionAll = mentionAllDraft,
    replyToSeq?: number | null,
    attachments: Array<ChatAttachment & { exp: number; claim: string }> = []
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
        attachments: attachments.length > 0 ? attachments : undefined,
      })
    );
  }

  function setPendingPhotoList(next: PendingChatPhoto[]) {
    const unique = visibleComposerPhotos(next);
    pendingPhotosRef.current = unique;
    setPendingPhotos(unique);
  }

  function abandonComposerPhotos() {
    composerGenRef.current += 1;
    const keys = pendingPhotosRef.current.map((item) => item.key);
    for (const key of keys) prepareJobsRef.current.delete(key);
    abandonChatPhotoPreupload(uploadJobsRef.current, keys);
    revokeChatPhotoPreviewUrls(pendingPhotosRef.current);
    setPendingPhotoList([]);
  }

  function applyPhotoUploadProgress(
    progress: ChatPhotoDirectProgress & { result?: ChatPhotoDirectResult },
    writeGeneration = composerGenRef.current
  ) {
    const next = applyComposerProgressIfCurrent(
      pendingPhotosRef.current,
      progress,
      composerGenRef.current,
      writeGeneration
    );
    if (next !== pendingPhotosRef.current) setPendingPhotoList(next);
    const line = linesRef.current.find((row) => row.localPhotos?.some((photo) => photo.key === progress.key));
    if (line) {
      patchOutgoingLine(line.clientMessageId, (cur) => ({
        ...cur,
        localPhotos: applyChatPhotoSendProgress(cur.localPhotos || [], progress),
      }));
    }
    if (progress.result?.size) noteChatPhotoBytes(progress.result.size, progress.result.size);
    if (progress.phase === "done" || progress.phase === "error") {
      emitChatPhotoTimingSummary();
      refreshPhotoDebugSample();
    }
  }

  function startComposerPreupload(item: ChatPendingPhoto, writeGeneration = composerGenRef.current) {
    const roomId = roomRef.current?.roomId || "";
    if (!roomId || item.status !== "ready") return;
    if (!pendingPhotosRef.current.some((row) => row.key === item.key)) return;
    void startChatPhotoPreupload(uploadJobsRef.current, roomId, item, {
      onProgress: (progress) => applyPhotoUploadProgress(progress, writeGeneration),
      chatToken: tokenRef.current?.token,
    }).catch(() => {
      // Composer stays usable; send/retry surfaces the error if the photo is still attached.
    });
  }

  async function addPendingPhotos(files: FileList | File[]) {
    const selectedAt = chatPhotoNow();
    const picked = commitComposerPhotoPicks(pendingPhotosRef.current, Array.from(files));
    const committed = {
      ...picked,
      ...appendComposerPhotos(pendingPhotosRef.current, picked.accepted),
    };
    const dropped = picked.rejected.concat(
      picked.accepted.filter((item) => !committed.accepted.some((row) => row.key === item.key))
    );
    if (dropped.length) revokeChatPhotoPreviewUrls(dropped);
    if (committed.note) setError(committed.note);
    if (committed.accepted.length === 0) return;
    if (pendingPhotosRef.current.length === 0) {
      resetChatPhotoTiming();
      stampChatPhotoTiming("photo_selected", selectedAt);
    }
    setPendingPhotoList(committed.items);
    markChatPhotoTiming("select_to_preview", selectedAt);
    const writeGeneration = composerGenRef.current;
    for (let i = 0; i < committed.accepted.length; i++) {
      const item = committed.accepted[i];
      const file = picked.sources.find((_, index) => picked.accepted[index]?.key === item.key)
        || committed.sources[i];
      if (!item || !file) continue;
      noteChatPhotoBytes(file.size, item.metrics?.uploadBytes);
      if (item.status === "ready" && !needsChatPhotoHeavyPrepare(file)) {
        markChatPhotoTiming("select_to_ready", selectedAt);
        stampChatPhotoTiming("prepare_complete");
        noteChatPhotoCompression(0);
        refreshPhotoDebugSample();
        startComposerPreupload(item, writeGeneration);
        continue;
      }
      const job = prepareChatPendingPhoto(item, file).then((prepared) => {
        markChatPhotoTiming("select_to_prepared", selectedAt);
        stampChatPhotoTiming("prepare_complete");
        if (prepared.metrics) {
          noteChatPhotoBytes(prepared.metrics.sourceBytes, prepared.metrics.uploadBytes);
          if (prepared.metrics.compressionMs != null) noteChatPhotoCompression(prepared.metrics.compressionMs);
        }
        refreshPhotoDebugSample();
        const applied = applyComposerPreparedIfCurrent(
          pendingPhotosRef.current,
          prepared,
          composerGenRef.current,
          writeGeneration
        );
        if (applied.note) setError(applied.note);
        if (applied.items !== pendingPhotosRef.current) setPendingPhotoList(applied.items);
        const current = applied.items.find((row) => row.key === prepared.key);
        if (current?.status === "ready") startComposerPreupload(current, writeGeneration);
        return prepared;
      });
      prepareJobsRef.current.set(item.key, job);
    }
  }

  function removePendingPhoto(key: string) {
    prepareJobsRef.current.delete(key);
    abandonChatPhotoPreupload(uploadJobsRef.current, [key]);
    const next = pendingPhotosRef.current.filter((item) => {
      if (item.key !== key) return true;
      URL.revokeObjectURL(item.previewUrl);
      return false;
    });
    setPendingPhotoList(next);
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

  async function finishOutgoingSend(
    line: ChatLine,
    roomId: string,
    tokens: ComposerMention[],
    mentionAll: boolean,
    replySeq?: number | null
  ) {
    const sendStarted = chatPhotoNow();
    let photos = (line.localPhotos || []).filter((item) => item.blob && item.blob.size > 0);
    if (photos.length) {
      const prepared = await Promise.all(
        photos.map((item) => {
          const queued = prepareJobsRef.current.get(item.key);
          if (queued) return queued;
          if (item.status === "ready") return Promise.resolve(item);
          const file =
            item.blob instanceof File
              ? item.blob
              : new File([item.blob], "photo.jpg", { type: item.blob.type || "image/jpeg" });
          return prepareChatPendingPhoto(item, file);
        })
      );
      for (const item of photos) prepareJobsRef.current.delete(item.key);
      photos = prepared;
      patchOutgoingLine(line.clientMessageId, (cur) => ({ ...cur, localPhotos: photos }));
    }
    const ready = photos.filter((item) => item.status === "ready");
    if (photos.some((item) => item.status !== "ready") || (ready.length === 0 && !line.body.trim())) {
      throw new Error("사진 처리에 실패했습니다.");
    }
    const uploaded = ready.length
      ? await finishChatPhotoOutgoingUploads({
          jobs: uploadJobsRef.current,
          roomId,
          photos: ready,
          pendingClaims: line.pendingClaims,
          onProgress: applyPhotoUploadProgress,
          chatToken: tokenRef.current?.token,
        })
      : line.pendingClaims || [];
    if (ready.length > 0) {
      patchOutgoingLine(line.clientMessageId, (cur) => ({
        ...cur,
        pendingClaims: uploaded,
        attachments: uploaded.map(({ id, mimeType, size }) => ({ id, mimeType, size })),
        localPhotos: ready.map((item, i) => ({
          ...item,
          send: {
            phase: "done",
            progress: 100,
            attachmentId: uploaded[i]?.id,
            result: uploaded[i],
          },
        })),
      }));
    }
    const wsStarted = chatPhotoNow();
    stampChatPhotoTiming("ws_send", wsStarted);
    await sendCurrent(line.body, line.clientMessageId, tokens, mentionAll, replySeq, uploaded);
    markChatPhotoTiming("message_ws_send", wsStarted);
    markChatPhotoTiming("total_send", sendStarted);
    emitChatPhotoTimingSummary();
    refreshPhotoDebugSample();
    for (const item of ready) uploadJobsRef.current.delete(item.key);
  }

  async function handleSend() {
    const body = draft.trim();
    const photos = pendingPhotosRef.current;
    if (!shouldStartOptimisticChatSend(body, photos) || !tokenInfo) return;
    const roomId = roomRef.current?.roomId || "";
    if (!roomId) return;
    const tokens = reconcileComposerMentions(body, mentionTokens);
    const mentionAll = reconcileMentionAll(body, mentionAllDraft);
    const clientMessageId = newClientMessageId();
    if (sendingRef.current.has(clientMessageId)) return;
    const reply = replyTo;
    const optimistic = buildOptimisticOutgoingLine(body, photos);
    const sendStarted = chatPhotoNow();
    stampChatPhotoTiming("send_tap", sendStarted);
    setError("");
    setDraft("");
    setMentionTokens([]);
    setMentionAllDraft(false);
    setMentionSuppressed(false);
    setReplyTo(null);
    composerGenRef.current += 1;
    setPendingPhotoList(leftoverComposerPhotosAfterSend(photos, usableOptimisticChatPhotos(photos).map((item) => item.key)));
    if (photoInputRef.current) photoInputRef.current.value = "";
    const outgoing: ChatLine = {
      clientMessageId,
      senderUserId: tokenInfo.user.userId,
      sender: tokenInfo.user.displayName,
      senderRole: tokenInfo.user.role,
      body,
      sentAt: new Date().toISOString(),
      mentions: tokens.map((t) => t.userId),
      mentionAll: isDmRoomId(roomId) ? false : mentionAll,
      attachments: [],
      pendingClaims: [],
      localPhotos: optimistic.localPhotos,
      replyToSeq: reply?.seq || null,
      replyTo: reply,
      status: "sending",
    };
    upsertLine(outgoing);
    markChatPhotoTiming("send_tap_to_local_bubble", sendStarted);
    sendingRef.current.add(clientMessageId);
    void finishOutgoingSend(outgoing, roomId, tokens, mentionAll, reply?.seq)
      .catch((e) => {
        patchOutgoingLine(clientMessageId, (cur) => ({
          ...cur,
          status: "failed",
        }));
        setError(e instanceof Error ? e.message : "사진 업로드에 실패했습니다.");
      })
      .finally(() => {
        sendingRef.current.delete(clientMessageId);
      });
  }

  async function retry(line: ChatLine) {
    const roomId = roomRef.current?.roomId || "";
    if (!roomId || sendingRef.current.has(line.clientMessageId)) return;
    sendingRef.current.add(line.clientMessageId);
    patchOutgoingLine(line.clientMessageId, (cur) => ({ ...cur, status: "sending" }));
    try {
      const latest = linesRef.current.find((row) => row.clientMessageId === line.clientMessageId) || {
        ...line,
        status: "sending" as const,
      };
      await finishOutgoingSend(
        latest,
        roomId,
        line.mentions.map((userId) => ({ userId, label: "" })),
        line.mentionAll,
        line.replyToSeq
      );
    } catch (e) {
      patchOutgoingLine(line.clientMessageId, (cur) => ({ ...cur, status: "failed" }));
      setError(e instanceof Error ? e.message : "사진 업로드에 실패했습니다.");
    } finally {
      sendingRef.current.delete(line.clientMessageId);
    }
  }

  function discardFailedLine(line: ChatLine) {
    if (line.seq) return;
    if (line.localPhotos?.length) revokeChatPhotoPreviewUrls(line.localPhotos);
    setLines((prev) => {
      const next = prev.filter((row) => row.clientMessageId !== line.clientMessageId);
      linesRef.current = next;
      return next;
    });
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
      preview: replyPreviewFromBody({ body: line.body, attachments: line.attachments }),
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
  const activeNotifyMode =
    activeRoom != null
      ? notifyPrefs[activeRoom.roomId] ?? DEFAULT_CHAT_NOTIFY_MODE
      : DEFAULT_CHAT_NOTIFY_MODE;
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
                entrySeekRef.current = false;
                entryPinRef.current = null;
                entrySnapshotRef.current = null;
                entryTargetRef.current = null;
                reconnectingRef.current = false;
                roomGenRef.current += 1;
                clearTimer(roomTimerRef);
                wsRef.current?.close();
                abandonComposerPhotos();
                clearLocalLines([]);
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
              aria-label={chatNotifyHeaderAriaLabel(activeNotifyMode)}
            >
              {chatNotifyHeaderLabel(activeNotifyMode)}
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
              if (programmaticScrollRef.current) return;
              const nearBottom = isNearChatBottom({
                scrollHeight: el.scrollHeight,
                scrollTop: el.scrollTop,
                clientHeight: el.clientHeight,
              });
              stickRef.current = nearBottom;
              if (nearBottom) setUnseenCount(0);
              if (entryPinRef.current) {
                userMovedScrollRef.current = true;
                entryPinRef.current = null;
              }
              if (
                shouldAutoLoadOlderOnScroll({
                  scrollTop: el.scrollTop,
                  nearBottom,
                  seeking: entrySeekRef.current,
                })
              ) {
                requestOlderHistory();
              }
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
              const showUnreadSplit = shouldShowUnreadSplit({
                firstUnreadSeq: entrySnapshotRef.current?.firstUnreadSeq ?? null,
                lineSeq: line.seq,
                prevSeq: prev?.seq,
              });
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
                  {showUnreadSplit ? (
                    <div className="vh-chat-unread-split" data-chat-unread-split={line.seq || undefined}>
                      {CHAT_UNREAD_SPLIT_LABEL}
                    </div>
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
                  {line.attachments?.length || line.localPhotos?.length ? (
                    <div className="vh-chat-photos">
                      {(line.attachments && line.attachments.length > 0
                        ? line.attachments.map((att) => ({
                            key: att.id,
                            src: outgoingChatPhotoSrc({
                              roomId: activeRoom?.roomId || roomRef.current?.roomId || "",
                              attachmentId: att.id,
                              chatPhotoSrc,
                            }),
                            sending: false,
                            progress: 0,
                          }))
                        : (line.localPhotos || []).map((item) => ({
                            key: item.key,
                            src: item.previewUrl,
                            sending: line.status === "sending",
                          }))
                      ).map((photo) => (
                          <button
                            key={photo.key}
                            type="button"
                            className={`vh-chat-photo-thumb${photo.sending ? " is-sending" : ""}`}
                            onClick={() => setLightbox({ src: photo.src })}
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={photo.src}
                              alt=""
                              loading="lazy"
                              decoding="async"
                              onLoad={() => applyPinnedEntryScroll()}
                              onError={(e) => {
                                e.currentTarget.classList.add("is-failed");
                              }}
                            />
                            {photo.sending ? (
                              <span className="vh-chat-photo-sending" aria-label="보내는 중" />
                            ) : null}
                            <span className="vh-chat-photo-fallback">사진을 불러오지 못했습니다.</span>
                          </button>
                      ))}
                    </div>
                  ) : null}
                  {line.body || !line.attachments?.length ? (
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
                  ) : null}
                  <div className="vh-chat-meta">
                    {formatTime(line.sentAt)}
                    {mine && line.status === "sending" ? " · 보내는 중" : ""}
                    {mine && line.status === "failed" ? " · 실패" : ""}
                  </div>
                  {mine && line.status === "failed" ? (
                    <div className="vh-chat-fail-actions">
                    <button type="button" className="vh-chat-retry" onClick={() => retry(line)}>
                      다시 보내기
                    </button>
                    {!line.seq ? (
                      <button type="button" className="vh-chat-retry" onClick={() => discardFailedLine(line)}>
                        삭제
                      </button>
                    ) : null}
                    </div>
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
            {pendingPhotos.length > 0 ? (
              <div className="vh-chat-pending-photos">
                {pendingPhotos.map((item) => (
                  <div
                    key={item.key}
                    className={
                      item.status === "failed" || item.send?.phase === "error"
                        ? "vh-chat-pending-photo is-failed"
                        : chatPhotoComposerBusy(item)
                          ? "vh-chat-pending-photo is-preparing"
                          : "vh-chat-pending-photo"
                    }
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={item.previewUrl} alt="" />
                    {chatPhotoComposerBusy(item) ? (
                      <span className="vh-chat-pending-spinner" aria-label="처리 중" />
                    ) : null}
                    {item.status === "failed" || item.send?.phase === "error" ? (
                      <button
                        type="button"
                        className="vh-chat-pending-retry"
                        onClick={() => {
                          const file =
                            item.blob instanceof File
                              ? item.blob
                              : new File([item.blob], "photo.jpg", { type: item.blob.type || "image/jpeg" });
                          const writeGeneration = composerGenRef.current;
                          const job = prepareChatPendingPhoto({ ...item, status: "preparing", error: undefined }, file).then(
                            (prepared) => {
                              const applied = applyComposerPreparedIfCurrent(
                                pendingPhotosRef.current,
                                prepared,
                                composerGenRef.current,
                                writeGeneration
                              );
                              if (applied.items !== pendingPhotosRef.current) setPendingPhotoList(applied.items);
                              const current = applied.items.find((row) => row.key === prepared.key);
                              if (current?.status === "ready") startComposerPreupload(current, writeGeneration);
                              return prepared;
                            }
                          );
                          prepareJobsRef.current.set(item.key, job);
                        }}
                      >
                        재시도
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="vh-chat-pending-x"
                        aria-label="사진 제거"
                        onClick={() => removePendingPhoto(item.key)}
                      >
                        X
                      </button>
                    )}
                  </div>
                ))}
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
            <input
              ref={photoInputRef}
              type="file"
              accept={CHAT_PHOTO_ACCEPT}
              multiple
              hidden
              onChange={(e) => {
                const files = e.target.files;
                if (files && files.length > 0) void addPendingPhotos(files);
                e.target.value = "";
              }}
            />
            <button
              type="button"
              className="vh-chat-photo-btn"
              aria-label="사진 첨부"
              disabled={pendingPhotos.length >= CHAT_PHOTO_MAX}
              onClick={() => photoInputRef.current?.click()}
            >
              사진
            </button>
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
              disabled={!draft.trim() && pendingPhotos.every((item) => item.status === "failed")}
            >
              전송
            </button>
            </div>
          </form>
          {photoDebug && photoDebugSample ? (
            <aside className="vh-chat-photo-debug" aria-label="Chat photo debug">
              {(
                [
                  ["sourceBytes", photoDebugSample.sourceBytes],
                  ["uploadBytes", photoDebugSample.uploadBytes],
                  ["compressionMs", photoDebugSample.compressionMs],
                  ["decodeMs", photoDebugSample.decodeMs],
                  ["drawResizeMs", photoDebugSample.drawResizeMs],
                  ["encode1Ms", photoDebugSample.encode1Ms],
                  ["encode2Ms", photoDebugSample.encode2Ms],
                  ["inputWidth", photoDebugSample.inputWidth],
                  ["inputHeight", photoDebugSample.inputHeight],
                  ["outputWidth", photoDebugSample.outputWidth],
                  ["outputHeight", photoDebugSample.outputHeight],
                  ["encodeAttempts", photoDebugSample.encodeAttempts],
                  ["encodeMime", photoDebugSample.encodeMime],
                  ["selectedToUploadStartMs", photoDebugSample.selectedToUploadStartMs],
                  ["prepareApiMs", photoDebugSample.prepareApiMs],
                  ["storageBackend", photoDebugSample.storageBackend],
                  ["blobPutMs", photoDebugSample.blobPutMs],
                  ["r2PutMs", photoDebugSample.r2PutMs],
                  ["workerUploadMs", photoDebugSample.workerUploadMs],
                  ["finalizeMs", photoDebugSample.finalizeMs],
                  ["sendTapToWsMs", photoDebugSample.sendTapToWsMs],
                  ["selectedToReadyMs", photoDebugSample.selectedToReadyMs],
                  ["totalUntilWsMs", photoDebugSample.totalUntilWsMs],
                  ["prepareServerMs", photoDebugSample.prepareServerMs],
                  ["prepareServerRegion", photoDebugSample.prepareServerRegion],
                  ["prepareAuthMs", photoDebugSample.prepareAuthMs],
                  ["prepareRoomAccessMs", photoDebugSample.prepareRoomAccessMs],
                  ["prepareCountMs", photoDebugSample.prepareCountMs],
                  ["prepareCreateMs", photoDebugSample.prepareCreateMs],
                  ["prepareSignedPutMs", photoDebugSample.prepareSignedPutMs],
                  ["finalizeServerMs", photoDebugSample.finalizeServerMs],
                  ["finalizeServerRegion", photoDebugSample.finalizeServerRegion],
                  ["finalizeAuthMs", photoDebugSample.finalizeAuthMs],
                  ["finalizeRoomAccessMs", photoDebugSample.finalizeRoomAccessMs],
                  ["finalizeDbFindMs", photoDebugSample.finalizeDbFindMs],
                  ["finalizeBlobMs", photoDebugSample.finalizeBlobMs],
                  ["r2InspectMs", photoDebugSample.r2InspectMs],
                  ["workerIngressMs", photoDebugSample.workerIngressMs],
                  ["workerHashMs", photoDebugSample.workerHashMs],
                  ["workerTotalMs", photoDebugSample.workerTotalMs],
                  ["r2StoreMs", photoDebugSample.r2StoreMs],
                  ["receiptVerifyMs", photoDebugSample.receiptVerifyMs],
                  ["finalizeInspectSkipped", photoDebugSample.finalizeInspectSkipped],
                  ["roomAccessFastPath", photoDebugSample.roomAccessFastPath],
                  ["roomAccessFallbackReason", photoDebugSample.roomAccessFallbackReason],
                  ["xhrStartMs", photoDebugSample.xhrStartMs],
                  ["xhrUploadCompleteMs", photoDebugSample.xhrUploadCompleteMs],
                  ["xhrResponseCompleteMs", photoDebugSample.xhrResponseCompleteMs],
                  ["clientUploadMs", photoDebugSample.clientUploadMs],
                  ["responseWaitMs", photoDebugSample.responseWaitMs],
                  ["connectionWaitMs", photoDebugSample.connectionWaitMs], // start → first upload progress (connection/preflight/scheduling)
                  ["finalizeDbUpdateMs", photoDebugSample.finalizeDbUpdateMs],
                  ["finalizeSignMs", photoDebugSample.finalizeSignMs],
                ] as const
              ).map(([key, value]) => (
                <div key={key}>
                  <span>{key}</span>
                  <span>{value == null ? "—" : value}</span>
                </div>
              ))}
            </aside>
          ) : null}
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
                activeRoom?.type === "ALL" ||
                (activeRoom?.type === "DM" && activeRoom.peerUserId === profileTarget.userId),
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

      {lightbox ? (
        <div
          className="vh-chat-lightbox"
          role="dialog"
          aria-label="사진 보기"
          onClick={() => setLightbox(null)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={lightbox.src} alt="" onClick={(e) => e.stopPropagation()} />
          <button type="button" className="vh-chat-lightbox-close" onClick={() => setLightbox(null)}>
            닫기
          </button>
        </div>
      ) : null}
    </div>
  );
}
