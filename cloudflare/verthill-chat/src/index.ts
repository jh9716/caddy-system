import { DurableObject } from "cloudflare:workers";
import { ChatDirectory } from "./directory";
import {
  chatInternalSecret,
  internalAuthHeaders,
  verifyInternalRequest,
} from "./internalAuth";
import {
  DIRECTORY_NAME,
  DIRECTORY_TOMBSTONE_PREVIEW,
  HISTORY_LIMIT,
  MAX_CONNECTIONS,
  MAX_CONNECTIONS_ALL,
  MESSAGE_MAX,
  MESSAGE_RETENTION_MS,
  REPLY_DELETED,
  RETENTION_ALARM_MS,
  RETENTION_BATCH,
  CHAT_ATTACHMENT_CLEANUP_BATCH,
  canAdminDelete,
  canDeleteForEveryone,
  clampSyncAfterSeq,
  directorySafePreview,
  filterMentionsToMembers,
  isAllRoomId,
  isCustomRoomId,
  isDirectoryRoomId,
  isDmRoomId,
  isLegacyTeamRoomId,
  isValidRoomName,
  mentionsToWire,
  parseDeletionType,
  parseOptionalSeq,
  parseAttachmentUpgraded,
  parseStoredAttachments,
  planOwnedAttachmentUpgrade,
  parseStoredMentionAll,
  parseStoredMentions,
  replyTargetFromRow,
  resolveMentionAll,
  senderRoleFromClaims,
  shouldPurgeChatAttachmentsOnDelete,
  storedAttachmentsFromIncoming,
  verifyChatAttachmentClaim,
  validateIncomingDelete,
  validateIncomingHide,
  validateIncomingHistory,
  validateIncomingMessage,
  validateIncomingRead,
  validateIncomingSync,
  type ChatDeletionType,
  type ChatMessage,
  type MessageDeletedEvent,
} from "./protocol";
import {
  chatTokenSessionVersion,
  isSessionBoundChatToken,
  isChatSessionEpochStale,
  resolveChatRoomAccess,
  verifyChatToken,
  parseChatTokenAudience,
  type ChatTokenClaims,
} from "./token";
import { handleChatMediaRequest, type ChatMediaBucket } from "./chatMedia";
import {
  CHAT_ROOM_EVICT_PATH,
  CHAT_ROOM_REVOKE_PATH,
  CHAT_SESSION_EPOCH_PATH,
  CHAT_SESSION_REVOKE_PATH,
  assertChatSessionCurrent,
  parseEvictMembersBody,
  parseSessionRevokeBody,
  probeChatSession,
  shouldSkipWorkerSessionCheck,
} from "./sessionCheck";
import { isPreviewWorker, nextAppExtraHeaders, nextAppFetchInit, nextAppUrl, nextPushDispatchUrl } from "./nextApp";
import {
  CHAT_PERF_HEADER,
  CHAT_PERF_PONG,
  emptyChatPerf,
  encodeChatPerfHeader,
  isPreviewChatPerf,
  isPreviewPerfPing,
  previewColo,
  previewPerfFrame,
  readChatPerfHeader,
  roundPerfMs,
  type ChatPerfT,
} from "./chatPerf";
import { BROWSER_CORS, withBrowserCors } from "./browserCors";
import {
  isRecheckDue,
  openSocketRecheckIntervalMs,
  retryCheckedAt,
} from "./openSocketRecheck";
import {
  ROOM_REVOKE_BUDGET_MS,
  ROOM_REVOKE_TIMEOUT_MS,
  revokeHttpStatus,
} from "./revokeFanout";

export { validateIncomingMessage, isValidRoomName } from "./protocol";
export { verifyChatToken } from "./token";
export { ChatDirectory };

export interface Env {
  CHAT_ROOM: DurableObjectNamespace<ChatRoom>;
  CHAT_DIRECTORY: DurableObjectNamespace<ChatDirectory>;
  CHAT_AUTH_SECRET: string;
  CHAT_INTERNAL_SECRET?: string;
  /** Preferred upload-grant secret. Falls back to CHAT_INTERNAL_SECRET. Do not set in this PR. */
  CHAT_MEDIA_SECRET?: string;
  /**
   * Optional chat-photo object store. Bind later as CHAT_MEDIA → verthill-chat-media.
   * Do not bind or deploy from this PR.
   */
  CHAT_MEDIA?: ChatMediaBucket;
  /** Optional Next origin for best-effort chat push. Example: https://www.verthill.kr/api/chat/push-dispatch */
  CHAT_PUSH_DISPATCH_URL?: string;
  /** "preview" = Preview 전용 Worker. 미설정/"production" = 운영. 그 외 값은 503(fail-closed). */
  CHAT_TOKEN_AUDIENCE?: string;
  /** 로컬 테스트 전용: 열린 소켓 재검증 주기(ms). 미설정 = 5분. 운영 설정 불필요. */
  CHAT_OPEN_SOCKET_RECHECK_MS?: string;
  /** Preview Worker 전용 secret (배포 보호 자동화 우회). 운영 Worker 에는 등록하지 않으며, 등록돼도 운영에서는 전송 안 함. */
  PREVIEW_APP_BYPASS_SECRET?: string;
  /** 로컬 테스트 하네스 전용("1"). 배포 설정에 넣지 않는다. */
  CHAT_PREVIEW_LOCAL_HARNESS?: string;
}

/** 운영: 기존과 동일. Preview: 검증된 Preview 호스트만 (nextApp.ts). */
function nextInternalUrl(env: Env, pathname: string): string {
  return nextAppUrl(env, pathname);
}

function uniqueAttachmentIds(raw: string[], limit: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    const id = String(value || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= limit) break;
  }
  return out;
}

function corsHeaders(): Record<string, string> {
  return { ...BROWSER_CORS };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...corsHeaders(),
    },
  });
}

function sendJson(ws: WebSocket, data: unknown) {
  ws.send(JSON.stringify(data));
}

function previewPerfBag(env: Env): ChatPerfT | undefined {
  return isPreviewChatPerf(env) ? emptyChatPerf() : undefined;
}

function attachPreviewPerf(request: Request, env: Env, perf: ChatPerfT | undefined): Request {
  if (!perf || !isPreviewChatPerf(env)) return request;
  const forwarded = new Request(request.url, request);
  forwarded.headers.delete(CHAT_PERF_HEADER);
  forwarded.headers.set(CHAT_PERF_HEADER, encodeChatPerfHeader(perf));
  return forwarded;
}

function sendPreviewPerf(env: Env, ws: WebSocket, t: ChatPerfT, request: Request) {
  if (!isPreviewChatPerf(env)) return;
  try {
    sendJson(ws, previewPerfFrame(t, previewColo(request.cf)));
  } catch {
    // 계측 실패는 채팅에 영향 없음
  }
}

function directoryStub(env: Env) {
  return env.CHAT_DIRECTORY.get(env.CHAT_DIRECTORY.idFromName(DIRECTORY_NAME));
}

type VerifyIdentityOptions = {
  /**
   * "skip": 토큰 서명·만료·audience 만 확인. Next/DB session-check 생략.
   * ChatRoom DO 의 authorizeSocket 이 최종 session-check 를 수행한다.
   * Directory 경로에서는 쓰지 않는다. c679e51 확인서(DO 인증 생략) 와는 반대.
   */
  sessionCheck?: "required" | "skip";
  /** Preview 전용 계측 가방. 운영에서는 넘기지 않는다. */
  perf?: ChatPerfT;
};

async function verifyIdentity(
  request: Request,
  env: Env,
  options?: VerifyIdentityOptions
): Promise<ChatTokenClaims | Response> {
  const url = new URL(request.url);
  const secret = String(env.CHAT_AUTH_SECRET || "").trim();
  if (!secret) return json({ error: "chat_auth_unconfigured" }, 503);
  // CHAT_TOKEN_AUDIENCE 미설정 = production (기존 운영 Worker 동작 그대로). preview Worker 는 "preview".
  const audience = parseChatTokenAudience(env.CHAT_TOKEN_AUDIENCE);
  if (!audience) return json({ error: "chat_audience_misconfigured" }, 503);
  const header = (request.headers.get("authorization") || "").trim();
  const bearer = header.toLowerCase().startsWith("bearer ")
    ? header.slice(7).trim()
    : "";
  const token = (url.searchParams.get("token") || bearer).trim();
  if (!token) return json({ error: "unauthorized" }, 401);
  const tTok = performance.now();
  const claims = await verifyChatToken(token, secret, undefined, audience);
  if (options?.perf) options.perf.tok = roundPerfMs(performance.now() - tTok);
  if (!claims) return json({ error: "invalid_token" }, 401);
  if (options?.sessionCheck !== "skip") {
    const session = await assertChatSessionCurrent(env, claims, options?.perf);
    if (!session.ok) return json({ error: session.error }, session.status);
    if (isSessionBoundChatToken(claims)) {
      void rememberSessionEpoch(env, claims.userId, claims.sv);
    }
  }
  return claims;
}

async function rememberSessionEpoch(
  env: Env,
  userId: number,
  sessionVersion: number
) {
  try {
    const path = CHAT_SESSION_EPOCH_PATH;
    const headers = await internalAuthHeaders(chatInternalSecret(env), path);
    await directoryStub(env).fetch(
      new Request(`https://chat-directory${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ userId, sessionVersion }),
      })
    );
  } catch {
    // new-connection check already succeeded
  }
}

async function listDirectoryMemberIds(env: Env, roomId: string): Promise<number[] | null> {
  const path = "/internal/member-ids";
  const headers = await internalAuthHeaders(chatInternalSecret(env), path);
  const res = await directoryStub(env).fetch(
    new Request(
      `https://chat-directory${path}?room=${encodeURIComponent(roomId)}`,
      { headers }
    )
  );
  if (!res.ok) return null;
  const data = (await res.json()) as { ids?: unknown };
  if (!Array.isArray(data.ids)) return [];
  return data.ids.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0);
}

async function isDirectoryMember(
  env: Env,
  roomId: string,
  userId: number
): Promise<boolean> {
  const path = "/internal/member";
  const headers = await internalAuthHeaders(chatInternalSecret(env), path);
  const res = await directoryStub(env).fetch(
    new Request(
      `https://chat-directory${path}?room=${encodeURIComponent(roomId)}&userId=${userId}`,
      { headers }
    )
  );
  if (!res.ok) return false;
  const data = (await res.json()) as { member?: boolean };
  return data.member === true;
}

async function authorizeSocket(
  request: Request,
  env: Env,
  options?: VerifyIdentityOptions
): Promise<{ room: string; claims: ChatTokenClaims } | Response> {
  const url = new URL(request.url);
  const room = (url.searchParams.get("room") || "").trim();
  if (!isValidRoomName(room)) {
    return json({ error: "invalid_room" }, 400);
  }
  const identity = await verifyIdentity(request, env, options);
  if (identity instanceof Response) return identity;
  const tMem = performance.now();
  const member =
    isCustomRoomId(room) || isDmRoomId(room)
      ? await isDirectoryMember(env, room, identity.userId)
      : isAllRoomId(room);
  if (options?.perf) options.perf.mem = roundPerfMs(performance.now() - tMem);
  const access = resolveChatRoomAccess({
    claims: identity,
    roomId: room,
    isMember: member,
    isAll: isAllRoomId(room),
    isCustom: isCustomRoomId(room),
    isDm: isDmRoomId(room),
    isLegacy: isLegacyTeamRoomId(room),
  });
  if (!access.ok) {
    const code = access.code === "invalid_room" ? "invalid_room" : "room_forbidden";
    return json({ error: code }, code === "invalid_room" ? 400 : 403);
  }
  return { room, claims: identity };
}

async function forwardDirectory(request: Request, env: Env): Promise<Response> {
  const t0 = performance.now();
  const perf = previewPerfBag(env);
  const identity = await verifyIdentity(request, env, perf ? { perf } : undefined);
  if (identity instanceof Response) return identity;
  if (perf) perf.edge = roundPerfMs(performance.now() - t0);
  // Must keep the inbound Request object. Rebuilding Request(url, {headers, body})
  // drops Cloudflare's WebSocket upgrade binding — ChatRoom works because it
  // forwards `request` unchanged. Directory list/WS used the rebuilt Request.
  const forwarded = new Request(request.url, request);
  forwarded.headers.set("x-chat-claims", JSON.stringify(identity));
  if (perf) {
    forwarded.headers.delete(CHAT_PERF_HEADER);
    forwarded.headers.set(CHAT_PERF_HEADER, encodeChatPerfHeader(perf));
  } else {
    forwarded.headers.delete(CHAT_PERF_HEADER);
  }
  // Directory DO json() has no CORS. Browser GET /directory/rooms/:id (WS reuse revalidation)
  // is cross-origin from the app origin; without these headers fetch() throws and reuse fail-closes.
  // 101 Directory WS is returned unchanged.
  const res = await directoryStub(env).fetch(forwarded);
  return withBrowserCors(res);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    if (request.method === "GET" && url.pathname === "/health") {
      return json({
        ok: true,
        service: "verthill-chat",
        capabilities: {
          chat_media_upgrade: true,
          attachment_upgraded: true,
        },
      });
    }
    if (url.pathname === "/ws") {
      const upgrade = request.headers.get("Upgrade");
      const sessionCheck = shouldSkipWorkerSessionCheck(url.pathname, upgrade)
        ? "skip"
        : "required";
      const t0 = performance.now();
      const perf = previewPerfBag(env);
      const authorized = await authorizeSocket(request, env, { sessionCheck, perf });
      if (authorized instanceof Response) return authorized;
      if (perf) perf.edge = roundPerfMs(performance.now() - t0);
      if ((upgrade || "").toLowerCase() !== "websocket") {
        return json({ error: "upgrade_required" }, 426);
      }
      const id = env.CHAT_ROOM.idFromName(authorized.room);
      return env.CHAT_ROOM.get(id).fetch(attachPreviewPerf(request, env, perf));
    }
    if (url.pathname === "/directory/ws") {
      return forwardDirectory(request, env);
    }
    if (request.method === "GET" && url.pathname === "/directory/rooms") {
      return forwardDirectory(request, env);
    }
    const membersMatch = /^\/directory\/rooms\/([^/]+)\/members$/.exec(url.pathname);
    if (request.method === "GET" && membersMatch) {
      return forwardDirectory(request, env);
    }
    const roomSummaryMatch = /^\/directory\/rooms\/([^/]+)$/.exec(url.pathname);
    if (request.method === "GET" && roomSummaryMatch) {
      return forwardDirectory(request, env);
    }
    if (request.method === "POST" && url.pathname === "/directory/rooms") {
      return createRoomFromGrant(request, env);
    }
    if (request.method === "POST" && url.pathname === CHAT_SESSION_REVOKE_PATH) {
      return revokeChatSession(request, env);
    }
    // Chat photo media: PUT /media/upload, POST /internal/media/inspect, GET|DELETE /internal/media/object
    const media = await handleChatMediaRequest(request, env);
    if (media) return media;
    return json({ error: "not_found" }, 404);
  },
};

async function revokeChatSession(request: Request, env: Env): Promise<Response> {
  if (request.headers.get("origin")) {
    return json({ error: "server_only" }, 403);
  }
  if (!(await verifyInternalRequest(request, env, CHAT_SESSION_REVOKE_PATH))) {
    return json({ error: "forbidden" }, 403);
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_payload" }, 400);
  }
  const parsed = parseSessionRevokeBody(body);
  if (!parsed) return json({ error: "invalid_payload" }, 400);
  const secret = chatInternalSecret(env);
  const dirHeaders = await internalAuthHeaders(secret, CHAT_SESSION_REVOKE_PATH);
  const roomHeaders = await internalAuthHeaders(secret, CHAT_ROOM_REVOKE_PATH);
  // Directory(epoch + directory 소켓 + Room fanout)와 전체방 직접 poke 를 병렬로, 각각 시간 상한.
  // 전체방 직접 poke 는 기존과 같이 보조(best-effort) — 성공 판정은 Directory 결과로만 한다.
  const [dir, allRoom] = await Promise.all([
    settleWithin(() =>
      directoryStub(env).fetch(
        new Request(`https://chat-directory${CHAT_SESSION_REVOKE_PATH}`, {
          method: "POST",
          headers: dirHeaders,
          body: JSON.stringify(parsed),
        })
      ),
      DIRECTORY_REVOKE_TIMEOUT_MS
    ),
    settleWithin(() =>
      env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName("all")).fetch(
        new Request(`https://chat-room${CHAT_ROOM_REVOKE_PATH}`, {
          method: "POST",
          headers: roomHeaders,
          body: JSON.stringify(parsed),
        })
      ),
      ROOM_REVOKE_TIMEOUT_MS
    ),
  ]);
  const allRoomOutcome =
    allRoom.kind === "ok" ? (allRoom.value.ok ? "ok" : "failed") : allRoom.kind;
  if (dir.kind !== "ok") {
    // epoch 기록 여부를 알 수 없음 → 실패(503, Next 재시도). 식별자·비밀값 없이 단계만.
    console.warn(`[chat-session-revoke] directory ${dir.kind}`);
    return json(
      { ok: false, status: "failed", stage: "directory", reason: dir.kind, allRoom: allRoomOutcome },
      revokeHttpStatus("failed")
    );
  }
  const dirRes = dir.value;
  const data = (await dirRes.json().catch(() => null)) as
    | ({ status?: unknown } & Record<string, unknown>)
    | null;
  if (dirRes.status >= 400 && dirRes.status < 500) {
    return json(data ?? { error: "directory_rejected" }, dirRes.status);
  }
  const status = data?.status === "ok" || data?.status === "partial" ? data.status : null;
  if (!data || !status) {
    return json(
      { ok: false, status: "failed", stage: "directory", reason: "bad_response", allRoom: allRoomOutcome },
      revokeHttpStatus("failed")
    );
  }
  if (status !== "ok") {
    const rooms = (data.rooms || {}) as Record<string, unknown>;
    console.warn(
      `[chat-session-revoke] partial rooms ok=${Number(rooms.ok) || 0}/${Number(rooms.total) || 0} failed=${Number(rooms.failed) || 0} timeout=${Number(rooms.timeout) || 0} skipped=${Number(rooms.skipped) || 0}`
    );
  }
  return json({ ...data, allRoom: allRoomOutcome }, revokeHttpStatus(status));
}

/** Directory 단계 상한: Room fanout 예산 + 여유. Next 시도당 2.5s 안에 응답이 도착하도록. */
const DIRECTORY_REVOKE_TIMEOUT_MS = ROOM_REVOKE_BUDGET_MS + 600;

type Settled<T> = { kind: "ok"; value: T } | { kind: "timeout" } | { kind: "error" };

async function settleWithin<T>(run: () => Promise<T>, ms: number): Promise<Settled<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run().then((value) => ({ kind: "ok" as const, value })),
      new Promise<Settled<T>>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "timeout" }), ms);
      }),
    ]);
  } catch {
    return { kind: "error" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function createRoomFromGrant(request: Request, env: Env): Promise<Response> {
  if (request.headers.get("origin")) {
    return json({ error: "server_only" }, 403);
  }
  const secret = chatInternalSecret(env);
  if (!secret) return json({ error: "chat_auth_unconfigured" }, 503);
  let body: { grant?: string };
  try {
    body = (await request.json()) as { grant?: string };
  } catch {
    return json({ error: "invalid_payload" }, 400);
  }
  const grant = await verifyCreateGrant(String(body.grant || ""), secret);
  if (!grant) return json({ error: "invalid_grant" }, 401);
  const headers = await internalAuthHeaders(secret, "/internal/create");
  const dirRes = await directoryStub(env).fetch(
    new Request("https://chat-directory/internal/create", {
      method: "POST",
      headers,
      body: JSON.stringify({
        roomId: grant.roomId,
        name: grant.name,
        ownerUserId: grant.ownerUserId,
        members: grant.members,
      }),
    })
  );
  const data = (await dirRes.json().catch(() => null)) as {
    error?: string;
    ok?: boolean;
    roomId?: string;
    idempotent?: boolean;
    repaired?: boolean;
    removed?: unknown;
    evicted?: number;
    evictStatus?: number;
  } | null;
  if (dirRes.ok && isDmRoomId(grant.roomId)) {
    const removed = Array.isArray(data?.removed)
      ? data.removed.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)
      : [];
    if (removed.length) {
      const evict = await evictChatRoomMembers(env, grant.roomId, removed);
      if (data && evict) {
        data.evicted = evict.evicted;
        data.evictStatus = evict.status;
      }
    }
  }
  return json(data ?? { error: "dm_create_failed" }, dirRes.status);
}

async function evictChatRoomMembers(
  env: Env,
  roomId: string,
  userIds: number[]
): Promise<{ status: number; evicted: number } | null> {
  const secret = chatInternalSecret(env);
  if (!secret || userIds.length === 0) return null;
  try {
    const headers = await internalAuthHeaders(secret, CHAT_ROOM_EVICT_PATH);
    const res = await env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(roomId)).fetch(
      new Request(`https://chat-room${CHAT_ROOM_EVICT_PATH}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ userIds }),
      })
    );
    const body = (await res.json().catch(() => null)) as { evicted?: unknown } | null;
    return {
      status: res.status,
      evicted: Number(body?.evicted || 0),
    };
  } catch {
    // Membership is already exact. New sockets fail closed.
    return { status: 0, evicted: 0 };
  }
}

type CreateGrant = {
  v: 1;
  op: "create_room";
  roomId: string;
  name: string;
  ownerUserId: number;
  members: { userId: number; displayName: string; role: string; team: string }[];
  iat: number;
  exp: number;
};

function canonicalGrant(grant: CreateGrant): string {
  const members = grant.members
    .map((m) => `${m.userId}:${m.displayName}:${m.role}:${m.team}`)
    .sort()
    .join(",");
  return [
    String(grant.v),
    grant.op,
    grant.roomId,
    grant.name,
    String(grant.ownerUserId),
    members,
    String(grant.iat),
    String(grant.exp),
  ].join("|");
}

function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

async function verifyCreateGrant(
  token: string,
  secret: string
): Promise<CreateGrant | null> {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  let payload: string;
  try {
    payload = new TextDecoder().decode(
      Uint8Array.from(atob(parts[0].replace(/-/g, "+").replace(/_/g, "/")), (c) =>
        c.charCodeAt(0)
      )
    );
  } catch {
    try {
      const pad = parts[0].length % 4 === 0 ? "" : "=".repeat(4 - (parts[0].length % 4));
      payload = new TextDecoder().decode(
        Uint8Array.from(atob(parts[0].replace(/-/g, "+").replace(/_/g, "/") + pad), (c) =>
          c.charCodeAt(0)
        )
      );
    } catch {
      return null;
    }
  }
  let grant: CreateGrant;
  try {
    grant = JSON.parse(payload) as CreateGrant;
  } catch {
    return null;
  }
  if (grant.v !== 1 || grant.op !== "create_room") return null;
  const canonical = canonicalGrant(grant);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const expected = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(canonical))
  );
  let got: Uint8Array;
  try {
    const pad = parts[1].length % 4 === 0 ? "" : "=".repeat(4 - (parts[1].length % 4));
    const bin = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/") + pad);
    got = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
  if (!timingSafeEqualBytes(expected, got)) return null;
  const now = Math.floor(Date.now() / 1000);
  if (grant.exp <= now || grant.iat > now + 30) return null;
  return grant;
}

/** sc = 마지막 세션 확인 시각(ms). 접속 시 session-check 통과 시각으로 시작. */
type SocketAttach = { claims: ChatTokenClaims; roomId: string; sc?: number };

export class ChatRoom extends DurableObject<Env> {
  private persistQueue: Promise<void> = Promise.resolve();
  /** 열린 소켓 재검증 진행 중인 userId(메모리; 유실돼도 다음 활동 때 다시 시작될 뿐). */
  private recheckInflight = new Set<number>();
  /** Preview 계측: 이 isolate 생성 시각·WS 핸드셰이크 횟수(비밀 아님). */
  private readonly bornAt = Date.now();
  private wsHandshakes = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        client_message_id TEXT NOT NULL UNIQUE,
        sender_user_id INTEGER NOT NULL DEFAULT 0,
        sender TEXT NOT NULL,
        sender_role TEXT NOT NULL DEFAULT 'caddy',
        body TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        mentions_json TEXT NOT NULL DEFAULT '[]',
        mention_all INTEGER NOT NULL DEFAULT 0
      )
    `);
    try {
      this.ctx.storage.sql.exec(
        `ALTER TABLE messages ADD COLUMN sender_user_id INTEGER NOT NULL DEFAULT 0`
      );
    } catch {
      // already present
    }
    try {
      this.ctx.storage.sql.exec(
        `ALTER TABLE messages ADD COLUMN sender_role TEXT NOT NULL DEFAULT 'caddy'`
      );
    } catch {
      // already present
    }
    try {
      this.ctx.storage.sql.exec(
        `ALTER TABLE messages ADD COLUMN mentions_json TEXT NOT NULL DEFAULT '[]'`
      );
    } catch {
      // already present
    }
    try {
      this.ctx.storage.sql.exec(
        `ALTER TABLE messages ADD COLUMN mention_all INTEGER NOT NULL DEFAULT 0`
      );
    } catch {
      // already present
    }
    try {
      this.ctx.storage.sql.exec(`ALTER TABLE messages ADD COLUMN reply_to_seq INTEGER`);
    } catch {
      // already present
    }
    try {
      this.ctx.storage.sql.exec(`ALTER TABLE messages ADD COLUMN deleted_at TEXT`);
    } catch {
      // already present
    }
    try {
      this.ctx.storage.sql.exec(`ALTER TABLE messages ADD COLUMN deletion_type TEXT`);
    } catch {
      // already present
    }
    try {
      this.ctx.storage.sql.exec(`ALTER TABLE messages ADD COLUMN deleted_by_user_id INTEGER`);
    } catch {
      // already present
    }
    try {
      this.ctx.storage.sql.exec(
        `ALTER TABLE messages ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]'`
      );
    } catch {
      // already present
    }
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS hidden_messages (
        user_id INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        hidden_at TEXT NOT NULL,
        PRIMARY KEY (user_id, seq)
      )
    `);
    this.ctx.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS messages_seq ON messages(seq)`
    );
    this.ctx.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS messages_sent_at ON messages(sent_at)`
    );
    this.ctx.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS messages_reply_to ON messages(reply_to_seq)`
    );
    this.ctx.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS hidden_messages_user ON hidden_messages(user_id)`
    );
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS revoked_sessions (
        user_id INTEGER PRIMARY KEY,
        session_version INTEGER NOT NULL
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS evicted_members (
        user_id INTEGER PRIMARY KEY,
        evicted_at TEXT NOT NULL
      )
    `);
    void this.ensureRetentionAlarm();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === CHAT_ROOM_REVOKE_PATH) {
      if (!(await verifyInternalRequest(request, this.env, url.pathname))) {
        return json({ error: "forbidden" }, 403);
      }
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return json({ error: "invalid_payload" }, 400);
      }
      const parsed = parseSessionRevokeBody(body);
      if (!parsed) return json({ error: "invalid_payload" }, 400);
      this.rememberRevoked(parsed.userId, parsed.sessionVersion);
      const closed = this.expireRevokedSockets(parsed.userId, parsed.sessionVersion);
      return json({ ok: true, closed });
    }
    if (request.method === "POST" && url.pathname === CHAT_ROOM_EVICT_PATH) {
      if (!(await verifyInternalRequest(request, this.env, url.pathname))) {
        return json({ error: "forbidden" }, 403);
      }
      let evictBody: unknown;
      try {
        evictBody = await request.json();
      } catch {
        return json({ error: "invalid_payload" }, 400);
      }
      const evict = parseEvictMembersBody(evictBody);
      if (!evict) return json({ error: "invalid_payload" }, 400);
      this.rememberEvicted(evict.userIds);
      const closed = this.evictMemberSockets(evict.userIds);
      return json({
        ok: true,
        evicted: closed,
        requested: evict.userIds.length,
        sockets: this.ctx.getWebSockets().length,
      });
    }
    if (request.method === "POST" && url.pathname === "/internal/retention") {
      if (!(await verifyInternalRequest(request, this.env, url.pathname))) {
        return json({ error: "forbidden" }, 403);
      }
      const pokedRoom = String(url.searchParams.get("room") || "").trim();
      if (pokedRoom) await this.rememberRoomId(pokedRoom);
      await this.ensureRetentionAlarm();
      const attachmentIds = this.purgeExpiredMessages(RETENTION_BATCH);
      const roomId = pokedRoom || (await this.storedRoomId());
      this.queueAttachmentCleanup(roomId, attachmentIds);
      return json({ ok: true, purged: attachmentIds.length });
    }
    // 최종 인가: 토큰 + Next/DB session-check + 멤버십. Worker /ws 가 session-check 를
    // 생략해도 여기서 다시 수행한다. c679e51 확인서로 이 호출을 건너뛰지 말 것.
    const preview = isPreviewChatPerf(this.env);
    const perf: ChatPerfT | undefined = preview
      ? { ...readChatPerfHeader(request.headers) }
      : undefined;
    const tDo = performance.now();
    const authorized = await authorizeSocket(
      request,
      this.env,
      perf ? { perf } : undefined
    );
    if (authorized instanceof Response) return authorized;
    if (perf) {
      perf.doAssert = roundPerfMs(performance.now() - tDo);
      perf.doFirst = this.wsHandshakes === 0 ? 1 : 0;
      perf.doAge = roundPerfMs(Date.now() - this.bornAt);
      this.wsHandshakes += 1;
    }
    const cap = isAllRoomId(authorized.room) ? MAX_CONNECTIONS_ALL : MAX_CONNECTIONS;
    if (this.ctx.getWebSockets().length >= cap) {
      return json({ error: "room_full" }, 503);
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const tAccept = performance.now();
    this.ctx.acceptWebSocket(server);
    const attach: SocketAttach = {
      claims: authorized.claims,
      roomId: authorized.room,
      sc: Date.now(),
    };
    server.serializeAttachment(attach);
    if (perf) perf.doAccept = roundPerfMs(performance.now() - tAccept);
    void this.rememberRoomId(authorized.room);
    const tHist = performance.now();
    this.sendHistory(server, authorized.claims.userId, null, HISTORY_LIMIT);
    if (perf) {
      perf.doHist = roundPerfMs(performance.now() - tHist);
      sendPreviewPerf(this.env, server, perf, request);
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const attach = this.readAttach(ws);
    if (!attach) return;
    if (typeof message === "string" && isPreviewPerfPing(this.env, message)) {
      try {
        ws.send(CHAT_PERF_PONG);
      } catch {
        // ignore
      }
      return;
    }
    if (typeof message !== "string") {
      sendJson(ws, {
        type: "error",
        code: "invalid_payload",
        message: "text JSON required",
      });
      return;
    }
    if (message.length > MESSAGE_MAX) {
      sendJson(ws, {
        type: "error",
        code: "payload_too_large",
        message: `payload max ${MESSAGE_MAX}`,
      });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      sendJson(ws, {
        type: "error",
        code: "invalid_payload",
        message: "malformed JSON",
      });
      return;
    }
    const type =
      parsed && typeof parsed === "object" ? String((parsed as { type?: unknown }).type || "") : "";
    if (type === "read") {
      const read = validateIncomingRead(parsed);
      if (!read.ok) {
        sendJson(ws, { type: "error", code: read.code, message: read.message });
        return;
      }
      void this.notifyDirectoryRead(attach.roomId, attach.claims.userId, read.seq);
      return;
    }
    if (type === "history") {
      const hist = validateIncomingHistory(parsed);
      if (!hist.ok) {
        sendJson(ws, { type: "error", code: hist.code, message: hist.message });
        return;
      }
      this.sendHistory(ws, attach.claims.userId, hist.beforeSeq, hist.limit);
      return;
    }
    if (type === "sync") {
      const sync = validateIncomingSync(parsed);
      if (!sync.ok) {
        sendJson(ws, { type: "error", code: sync.code, message: sync.message });
        return;
      }
      this.sendSync(ws, attach.claims.userId, sync.afterSeq, sync.limit);
      return;
    }
    if (type === "hide") {
      const hide = validateIncomingHide(parsed);
      if (!hide.ok) {
        sendJson(ws, { type: "error", code: hide.code, message: hide.message });
        return;
      }
      this.persistQueue = this.persistQueue
        .then(() => this.hideForMe(ws, attach, hide.seq))
        .catch(() => undefined);
      return;
    }
    if (type === "delete") {
      const del = validateIncomingDelete(parsed);
      if (!del.ok) {
        sendJson(ws, { type: "error", code: del.code, message: del.message });
        return;
      }
      this.persistQueue = this.persistQueue
        .then(() => this.deleteMessage(ws, attach, del.seq, del.mode))
        .catch(() => undefined);
      return;
    }
    if (type === "attachment_upgraded") {
      const upgraded = parseAttachmentUpgraded(parsed);
      if (!upgraded) {
        sendJson(ws, {
          type: "error",
          code: "invalid_attachment",
          message: "attachment rejected",
        });
        return;
      }
      this.applyAttachmentUpgrade(attach.claims.userId, upgraded.attachmentId, upgraded.size, ws);
      return;
    }
    const checked = validateIncomingMessage(parsed);
    if (!checked.ok) {
      sendJson(ws, {
        type: "error",
        code: checked.code,
        message: checked.message,
      });
      return;
    }
    this.persistQueue = this.persistQueue
      .then(() => this.persistMessage(ws, attach, checked.value))
      .catch(() => undefined);
  }

  private async persistMessage(
    ws: WebSocket,
    attach: SocketAttach,
    value: {
      clientMessageId: string;
      body: string;
      mentions: unknown;
      mentionAll: unknown;
      replyToSeq: unknown;
      attachments: import("./protocol").ChatAttachmentIncoming[];
    }
  ) {
    const sentAt = new Date().toISOString();
    const existing = this.ctx.storage.sql
      .exec(
        `SELECT seq FROM messages WHERE client_message_id = ?`,
        value.clientMessageId
      )
      .toArray();
    if (existing.length > 0) {
      sendJson(ws, {
        type: "duplicate",
        clientMessageId: value.clientMessageId,
      });
      return;
    }

    const senderRole = senderRoleFromClaims(attach.claims.role);
    const mentionAll = resolveMentionAll(value.mentionAll, senderRole, attach.roomId);
    let mentionIds = mentionsToWire(value.mentions).map((m) => m.userId);
    if ((isCustomRoomId(attach.roomId) || isDmRoomId(attach.roomId)) && mentionIds.length > 0) {
      const memberIds = await listDirectoryMemberIds(this.env, attach.roomId);
      mentionIds = filterMentionsToMembers(mentionIds, memberIds ?? []);
    }
    const mentions = mentionsToWire(mentionIds);
    const replyToSeq = parseOptionalSeq(value.replyToSeq);
    if (value.replyToSeq != null && value.replyToSeq !== "" && replyToSeq == null) {
      sendJson(ws, { type: "error", code: "invalid_reply", message: "replyToSeq required" });
      return;
    }
    if (replyToSeq != null) {
      const target = this.ctx.storage.sql
        .exec(`SELECT seq FROM messages WHERE seq = ?`, replyToSeq)
        .toArray();
      if (target.length === 0) {
        sendJson(ws, { type: "error", code: "reply_missing", message: "reply target missing" });
        return;
      }
    }

    const incomingAttachments = value.attachments || [];
    if (incomingAttachments.length > 0) {
      const secret = String(this.env.CHAT_AUTH_SECRET || "").trim();
      for (const attachment of incomingAttachments) {
        const ok = await verifyChatAttachmentClaim(secret, attachment, {
          roomId: attach.roomId,
          senderUserId: attach.claims.userId,
        });
        if (!ok) {
          sendJson(ws, {
            type: "error",
            code: "invalid_attachment",
            message: "attachment rejected",
          });
          return;
        }
      }
    }
    const attachments = storedAttachmentsFromIncoming(incomingAttachments);

    this.ctx.storage.sql.exec(
      `INSERT INTO messages
        (client_message_id, sender_user_id, sender, sender_role, body, sent_at, mentions_json, mention_all, reply_to_seq, attachments_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      value.clientMessageId,
      attach.claims.userId,
      attach.claims.displayName,
      senderRole,
      value.body,
      sentAt,
      JSON.stringify(mentions),
      mentionAll ? 1 : 0,
      replyToSeq,
      JSON.stringify(attachments)
    );
    const inserted = this.loadMessageByClientId(value.clientMessageId);
    if (!inserted) return;
    this.broadcastVisible(inserted);
    void this.notifyDirectoryMessage(attach.roomId, inserted);
    this.queueChatPushDispatch(attach.roomId, inserted);
    if (attachments.length > 0) {
      void this.consumeChatAttachments(attachments.map((item) => item.id));
    }
  }

  webSocketClose(ws: WebSocket) {
    try {
      ws.close(1000, "closed");
    } catch {
      // already closed
    }
  }

  webSocketError(ws: WebSocket) {
    try {
      ws.close(1011, "error");
    } catch {
      // already closed
    }
  }

  private readAttach(ws: WebSocket): SocketAttach | null {
    const raw = ws.deserializeAttachment() as SocketAttach | ChatTokenClaims | null;
    if (!raw) return this.expire(ws);
    if ("claims" in raw && raw.claims) {
      if (raw.claims.exp <= Math.floor(Date.now() / 1000)) return this.expire(ws);
      if (this.isRevoked(raw.claims)) return this.expire(ws, "stale_session");
      if (this.isEvicted(raw.claims.userId)) return this.expire(ws, "room_forbidden");
      this.maybeRecheckOpenSession(raw);
      return raw;
    }
    const claims = raw as ChatTokenClaims;
    if (claims.exp <= Math.floor(Date.now() / 1000)) return this.expire(ws);
    if (this.isRevoked(claims)) return this.expire(ws, "stale_session");
    if (this.isEvicted(claims.userId)) return this.expire(ws, "room_forbidden");
    return { claims, roomId: claims.v === 1 ? claims.room : "" };
  }

  private expire(
    ws: WebSocket,
    code: "expired_token" | "stale_session" | "room_forbidden" = "expired_token"
  ): null {
    const message =
      code === "stale_session"
        ? "session revoked"
        : code === "room_forbidden"
          ? "not a member"
          : "token expired";
    try {
      sendJson(ws, {
        type: "error",
        code,
        message,
      });
    } catch {
      // still close
    }
    try {
      ws.close(code === "room_forbidden" ? 4003 : 4008, code);
    } catch {
      // ignore
    }
    return null;
  }

  private rememberRevoked(userId: number, sessionVersion: number) {
    const row = this.ctx.storage.sql
      .exec(`SELECT session_version FROM revoked_sessions WHERE user_id = ?`, userId)
      .toArray()[0];
    const current = row ? Number(row.session_version) : -1;
    const next = Math.max(current, sessionVersion);
    this.ctx.storage.sql.exec(
      `INSERT INTO revoked_sessions (user_id, session_version) VALUES (?, ?)
       ON CONFLICT(user_id) DO UPDATE SET session_version = excluded.session_version`,
      userId,
      next
    );
  }

  private storedRevokedSv(userId: number): number | null {
    const row = this.ctx.storage.sql
      .exec(`SELECT session_version FROM revoked_sessions WHERE user_id = ?`, userId)
      .toArray()[0];
    if (!row) return null;
    const sv = Number(row.session_version);
    return Number.isInteger(sv) && sv >= 0 ? sv : null;
  }

  private isRevoked(claims: ChatTokenClaims): boolean {
    return isChatSessionEpochStale(
      chatTokenSessionVersion(claims),
      this.storedRevokedSv(claims.userId)
    );
  }

  private expireRevokedSockets(userId: number, sessionVersion: number): number {
    let closed = 0;
    for (const socket of this.ctx.getWebSockets()) {
      const attach = socket.deserializeAttachment() as SocketAttach | ChatTokenClaims | null;
      if (!attach) continue;
      const claims = "claims" in attach && attach.claims ? attach.claims : (attach as ChatTokenClaims);
      if (!claims || Number(claims.userId) !== userId) continue;
      if (!isChatSessionEpochStale(chatTokenSessionVersion(claims), sessionVersion)) continue;
      this.expire(socket, "stale_session");
      closed += 1;
    }
    return closed;
  }

  /** 핫패스: 숫자 비교만. 주기가 지난 v2 소켓이면 사용자별 1회 비동기 재검증 시작. */
  private maybeRecheckOpenSession(attach: SocketAttach) {
    const claims = attach.claims;
    if (claims.v !== 2) return;
    const interval = openSocketRecheckIntervalMs(this.env.CHAT_OPEN_SOCKET_RECHECK_MS);
    if (!isRecheckDue(attach.sc, Date.now(), interval)) return;
    const userId = Number(claims.userId);
    if (this.recheckInflight.has(userId)) return;
    this.recheckInflight.add(userId);
    void this.recheckOpenSession(claims, interval)
      .catch(() => undefined)
      .finally(() => this.recheckInflight.delete(userId));
  }

  private async recheckOpenSession(claims: ChatTokenClaims, interval: number) {
    const result = await probeChatSession(this.env, claims);
    const userId = Number(claims.userId);
    const tokenSv = chatTokenSessionVersion(claims);
    const now = Date.now();
    for (const socket of this.ctx.getWebSockets()) {
      const raw = socket.deserializeAttachment() as SocketAttach | ChatTokenClaims | null;
      if (!raw || !("claims" in raw) || !raw.claims) continue;
      if (Number(raw.claims.userId) !== userId) continue;
      const sv = chatTokenSessionVersion(raw.claims);
      if (result === "revoked") {
        // 같은/더 낮은 sv 만 종료(같은 사용자의 더 새 토큰 소켓은 별도 확인). 상태 저장 없음.
        if (tokenSv != null && sv != null && sv <= tokenSv) this.expire(socket, "stale_session");
        continue;
      }
      if (sv !== tokenSv) continue;
      try {
        socket.serializeAttachment({
          ...raw,
          sc: result === "current" ? now : retryCheckedAt(now, interval),
        });
      } catch {
        // closing socket
      }
    }
  }

  private rememberEvicted(userIds: number[]) {
    const at = new Date().toISOString();
    for (const userId of userIds) {
      this.ctx.storage.sql.exec(
        `INSERT INTO evicted_members (user_id, evicted_at) VALUES (?, ?)
         ON CONFLICT(user_id) DO UPDATE SET evicted_at = excluded.evicted_at`,
        userId,
        at
      );
    }
  }

  private isEvicted(userId: number): boolean {
    const rows = this.ctx.storage.sql
      .exec(`SELECT 1 AS ok FROM evicted_members WHERE user_id = ?`, userId)
      .toArray();
    return rows.length > 0;
  }

  private evictMemberSockets(userIds: number[]): number {
    const deny = new Set(userIds);
    if (deny.size === 0) return 0;
    let closed = 0;
    for (const socket of this.ctx.getWebSockets()) {
      const attach = socket.deserializeAttachment() as SocketAttach | ChatTokenClaims | null;
      if (!attach) continue;
      const claims = "claims" in attach && attach.claims ? attach.claims : (attach as ChatTokenClaims);
      if (!claims || !deny.has(Number(claims.userId))) continue;
      this.expire(socket, "room_forbidden");
      closed += 1;
    }
    return closed;
  }

  private messageSelectSql() {
    return `SELECT m.seq, m.client_message_id, m.sender_user_id, m.sender, m.sender_role,
              m.body, m.sent_at, m.mentions_json, m.mention_all, m.reply_to_seq,
              m.attachments_json, m.deleted_at, m.deletion_type,
              r.seq AS reply_seq, r.sender_user_id AS reply_sender_user_id,
              r.sender AS reply_sender, r.body AS reply_body,
              r.attachments_json AS reply_attachments_json,
              r.deletion_type AS reply_deletion_type,
              rh.seq AS reply_hidden
            FROM messages m
            LEFT JOIN hidden_messages h ON h.user_id = ? AND h.seq = m.seq
            LEFT JOIN messages r ON r.seq = m.reply_to_seq
            LEFT JOIN hidden_messages rh ON rh.user_id = ? AND rh.seq = m.reply_to_seq
            WHERE h.seq IS NULL`;
  }

  private rowToMessage(row: Record<string, unknown>): ChatMessage {
    const deletionType = parseDeletionType(row.deletion_type);
    const replyToSeq = parseOptionalSeq(row.reply_to_seq);
    return {
      type: "message",
      clientMessageId: String(row.client_message_id),
      senderUserId: Number(row.sender_user_id || 0),
      sender: String(row.sender),
      senderRole: senderRoleFromClaims(String(row.sender_role || "caddy")),
      body: deletionType ? "" : String(row.body || ""),
      sentAt: String(row.sent_at),
      seq: Number(row.seq),
      mentions: deletionType ? [] : parseStoredMentions(row.mentions_json),
      mentionAll: deletionType ? false : parseStoredMentionAll(row.mention_all),
      attachments: deletionType ? [] : parseStoredAttachments(row.attachments_json),
      replyToSeq,
      replyTo: replyTargetFromRow({
        replyToSeq,
        targetSeq: parseOptionalSeq(row.reply_seq),
        targetSenderUserId: Number(row.reply_sender_user_id || 0),
        targetSender: row.reply_sender == null ? "" : String(row.reply_sender),
        targetBody: row.reply_body == null ? "" : String(row.reply_body),
        targetAttachments: row.reply_attachments_json,
        targetDeletionType: row.reply_deletion_type,
        targetHidden: row.reply_hidden != null && row.reply_hidden !== "",
      }),
      deletionType,
      deletedAt: row.deleted_at ? String(row.deleted_at) : null,
    };
  }

  private loadMessageByClientId(clientMessageId: string): ChatMessage | null {
    const row = this.ctx.storage.sql
      .exec(
        `SELECT m.seq, m.client_message_id, m.sender_user_id, m.sender, m.sender_role,
                m.body, m.sent_at, m.mentions_json, m.mention_all, m.reply_to_seq,
                m.attachments_json, m.deleted_at, m.deletion_type,
                r.seq AS reply_seq, r.sender_user_id AS reply_sender_user_id,
                r.sender AS reply_sender, r.body AS reply_body,
                r.attachments_json AS reply_attachments_json,
                r.deletion_type AS reply_deletion_type
         FROM messages m
         LEFT JOIN messages r ON r.seq = m.reply_to_seq
         WHERE m.client_message_id = ?`,
        clientMessageId
      )
      .toArray()[0];
    return row ? this.rowToMessage(row) : null;
  }

  private sendHistory(ws: WebSocket, userId: number, beforeSeq: number | null, limit: number) {
    const rows =
      beforeSeq == null
        ? this.ctx.storage.sql
            .exec(
              `${this.messageSelectSql()}
               ORDER BY m.seq DESC
               LIMIT ?`,
              userId,
              userId,
              limit
            )
            .toArray()
        : this.ctx.storage.sql
            .exec(
              `${this.messageSelectSql()}
               AND m.seq < ?
               ORDER BY m.seq DESC
               LIMIT ?`,
              userId,
              userId,
              beforeSeq,
              limit
            )
            .toArray();
    rows.reverse();
    const messages = rows.map((row) => this.rowToMessage(row));
    const oldestSeq = messages.length ? Number(messages[0]!.seq) : null;
    let hasMore = false;
    if (oldestSeq != null) {
      const older = this.ctx.storage.sql
        .exec(
          `SELECT 1 AS ok FROM messages m
           LEFT JOIN hidden_messages h ON h.user_id = ? AND h.seq = m.seq
           WHERE h.seq IS NULL AND m.seq < ?
           LIMIT 1`,
          userId,
          oldestSeq
        )
        .toArray();
      hasMore = older.length > 0;
    }
    sendJson(ws, {
      type: "history",
      messages,
      hasMore,
      oldestSeq,
    });
  }

  private sendSync(ws: WebSocket, userId: number, afterSeq: number, limit: number) {
    const maxRow = this.ctx.storage.sql
      .exec(`SELECT MAX(seq) AS max_seq FROM messages`)
      .toArray()[0];
    const after = clampSyncAfterSeq(afterSeq, Number(maxRow?.max_seq || 0));
    const rows = this.ctx.storage.sql
      .exec(
        `${this.messageSelectSql()}
         AND m.seq > ?
         ORDER BY m.seq ASC
         LIMIT ?`,
        userId,
        userId,
        after,
        limit
      )
      .toArray();
    const messages = rows.map((row) => this.rowToMessage(row));
    const newestSeq = messages.length ? Number(messages[messages.length - 1]!.seq) : after;
    const newer = this.ctx.storage.sql
      .exec(
        `SELECT 1 AS ok FROM messages m
         LEFT JOIN hidden_messages h ON h.user_id = ? AND h.seq = m.seq
         WHERE h.seq IS NULL AND m.seq > ?
         LIMIT 1`,
        userId,
        newestSeq
      )
      .toArray();
    sendJson(ws, {
      type: "sync",
      messages,
      hasMore: newer.length > 0,
      newestSeq,
    });
  }

  private hideForMe(ws: WebSocket, attach: SocketAttach, seq: number) {
    const exists = this.ctx.storage.sql
      .exec(`SELECT seq FROM messages WHERE seq = ?`, seq)
      .toArray();
    if (exists.length === 0) {
      sendJson(ws, { type: "error", code: "hide_missing", message: "message missing" });
      return;
    }
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO hidden_messages (user_id, seq, hidden_at) VALUES (?, ?, ?)`,
      attach.claims.userId,
      seq,
      new Date().toISOString()
    );
    this.sendToUser(attach.claims.userId, { type: "hidden", seq });
  }

  private deleteMessage(
    ws: WebSocket,
    attach: SocketAttach,
    seq: number,
    mode: "everyone" | "admin"
  ) {
    const row = this.ctx.storage.sql
      .exec(
        `SELECT seq, sender_user_id, sender, sender_role, sent_at, deletion_type, attachments_json
         FROM messages WHERE seq = ?`,
        seq
      )
      .toArray()[0];
    if (!row) {
      sendJson(ws, { type: "error", code: "delete_missing", message: "message missing" });
      return;
    }
    if (parseDeletionType(row.deletion_type)) {
      sendJson(ws, { type: "error", code: "already_deleted", message: "already deleted" });
      return;
    }
    const senderUserId = Number(row.sender_user_id || 0);
    const sentAtMs = new Date(String(row.sent_at)).getTime();
    if (mode === "admin") {
      if (!canAdminDelete(attach.claims.role)) {
        sendJson(ws, { type: "error", code: "forbidden", message: "admin only" });
        return;
      }
    } else if (
      !canDeleteForEveryone({
        actorUserId: attach.claims.userId,
        senderUserId,
        sentAtMs,
      })
    ) {
      sendJson(ws, { type: "error", code: "delete_window", message: "delete window closed" });
      return;
    }
    const deletedAt = new Date().toISOString();
    const deletionType: ChatDeletionType = mode;
    this.ctx.storage.sql.exec(
      `UPDATE messages
       SET body = '',
           mentions_json = '[]',
           mention_all = 0,
           attachments_json = '[]',
           deleted_at = ?,
           deletion_type = ?,
           deleted_by_user_id = ?
       WHERE seq = ?`,
      deletedAt,
      deletionType,
      attach.claims.userId,
      seq
    );
    const event: MessageDeletedEvent = {
      type: "message_deleted",
      seq,
      deletionType,
      deletedAt,
      senderUserId,
      sender: String(row.sender),
      senderRole: senderRoleFromClaims(String(row.sender_role || "caddy")),
      sentAt: String(row.sent_at),
    };
    this.broadcastJson(event);
    void this.notifyDirectoryTombstone(attach.roomId, event);
    if (shouldPurgeChatAttachmentsOnDelete(deletionType)) {
      const attachmentIds = parseStoredAttachments(row.attachments_json).map((item) => item.id);
      this.queueAttachmentCleanup(attach.roomId, attachmentIds);
    }
  }

  private liveAttach(socket: WebSocket): SocketAttach | null {
    const attach = socket.deserializeAttachment() as SocketAttach | ChatTokenClaims | null;
    const now = Math.floor(Date.now() / 1000);
    if (!attach) return this.expire(socket);
    if ("claims" in attach && attach.claims) {
      if (attach.claims.exp <= now) return this.expire(socket);
      if (this.isRevoked(attach.claims)) return this.expire(socket, "stale_session");
      if (this.isEvicted(attach.claims.userId)) return this.expire(socket, "room_forbidden");
      this.maybeRecheckOpenSession(attach);
      return attach;
    }
    const claims = attach as ChatTokenClaims;
    if (claims.exp <= now) return this.expire(socket);
    if (this.isRevoked(claims)) return this.expire(socket, "stale_session");
    if (this.isEvicted(claims.userId)) return this.expire(socket, "room_forbidden");
    return { claims, roomId: claims.v === 1 ? claims.room : "" };
  }

  private applyAttachmentUpgrade(
    senderUserId: number,
    attachmentId: string,
    size: number,
    ws: WebSocket
  ) {
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT seq, sender_user_id, attachments_json FROM messages WHERE attachments_json LIKE ?`,
        `%${attachmentId}%`
      )
      .toArray() as Array<{ seq: number; sender_user_id: number; attachments_json: string }>;
    const planned = planOwnedAttachmentUpgrade({
      senderUserId,
      attachmentId,
      size,
      rows: rows.map((row) => ({
        seq: Number(row.seq),
        senderUserId: Number(row.sender_user_id),
        attachmentsJson: String(row.attachments_json || ""),
      })),
    });
    if (!planned.ok) {
      sendJson(ws, {
        type: "error",
        code: "forbidden",
        message: "attachment rejected",
      });
      return;
    }
    for (const update of planned.updates) {
      this.ctx.storage.sql.exec(
        `UPDATE messages SET attachments_json = ? WHERE seq = ?`,
        update.attachmentsJson,
        update.seq
      );
    }
    if (planned.broadcast) this.broadcastJson(planned.broadcast);
  }

  private broadcastVisible(event: ChatMessage) {
    for (const socket of this.ctx.getWebSockets()) {
      const attach = this.liveAttach(socket);
      if (!attach) continue;
      if (event.seq && this.isHiddenFor(attach.claims.userId, event.seq)) continue;
      this.sendSocket(socket, this.redactHiddenReply(event, attach.claims.userId));
    }
  }

  private redactHiddenReply(event: ChatMessage, userId: number): ChatMessage {
    const replySeq = event.replyToSeq;
    if (replySeq == null || !event.replyTo || !this.isHiddenFor(userId, replySeq)) {
      return event;
    }
    return {
      ...event,
      replyTo: {
        seq: replySeq,
        senderUserId: 0,
        sender: "",
        preview: REPLY_DELETED,
        state: "deleted",
      },
    };
  }

  private broadcastJson(event: object) {
    for (const socket of this.ctx.getWebSockets()) {
      const attach = this.liveAttach(socket);
      if (!attach) continue;
      this.sendSocket(socket, event);
    }
  }

  private sendToUser(userId: number, event: object) {
    for (const socket of this.ctx.getWebSockets()) {
      const attach = this.liveAttach(socket);
      if (!attach || attach.claims.userId !== userId) continue;
      this.sendSocket(socket, event);
    }
  }

  private sendSocket(socket: WebSocket, event: object) {
    try {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(event));
      } else {
        socket.close(1011, "dead");
      }
    } catch {
      try {
        socket.close(1011, "send_failed");
      } catch {
        // ignore
      }
    }
  }

  private isHiddenFor(userId: number, seq: number): boolean {
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT 1 AS ok FROM hidden_messages WHERE user_id = ? AND seq = ?`,
        userId,
        seq
      )
      .toArray();
    return rows.length > 0;
  }

  private latestVisiblePreview(): {
    seq: number;
    preview: string;
    senderUserId: number;
    senderName: string;
    senderRole: string;
    sentAt: string;
  } | null {
    const row = this.ctx.storage.sql
      .exec(
        `SELECT seq, sender_user_id, sender, sender_role, body, sent_at, deletion_type, attachments_json
         FROM messages
         ORDER BY seq DESC
         LIMIT 1`
      )
      .toArray()[0];
    if (!row) return null;
    const deletionType = parseDeletionType(row.deletion_type);
    return {
      seq: Number(row.seq),
      preview: directorySafePreview({
        body: String(row.body || ""),
        deletionType,
        attachments: row.attachments_json,
      }),
      senderUserId: Number(row.sender_user_id || 0),
      senderName: String(row.sender || ""),
      senderRole: String(row.sender_role || "caddy"),
      sentAt: String(row.sent_at),
    };
  }

  async alarm() {
    let delay = RETENTION_ALARM_MS;
    try {
      const attachmentIds = this.purgeExpiredMessages(RETENTION_BATCH);
      this.queueAttachmentCleanup(await this.storedRoomId(), attachmentIds);
      const remaining = this.ctx.storage.sql
        .exec(
          `SELECT 1 AS ok FROM messages WHERE sent_at < ? LIMIT 1`,
          new Date(Date.now() - MESSAGE_RETENTION_MS).toISOString()
        )
        .toArray();
      if (remaining.length > 0) delay = 5 * 60 * 1000;
    } catch {
      delay = 5 * 60 * 1000;
    } finally {
      try {
        await this.ctx.storage.setAlarm(Date.now() + delay);
      } catch {
        // alarm optional on local
      }
    }
  }

  private async ensureRetentionAlarm() {
    try {
      const existing = await this.ctx.storage.getAlarm();
      if (existing == null) {
        await this.ctx.storage.setAlarm(Date.now() + RETENTION_ALARM_MS);
      }
    } catch {
      // alarm optional on local
    }
  }

  private purgeExpiredMessages(limit: number): string[] {
    const cutoff = new Date(Date.now() - MESSAGE_RETENTION_MS).toISOString();
    const old = this.ctx.storage.sql
      .exec(
        `SELECT seq, attachments_json FROM messages WHERE sent_at < ? ORDER BY seq ASC LIMIT ?`,
        cutoff,
        limit
      )
      .toArray();
    const attachmentIds: string[] = [];
    for (const row of old) {
      const seq = Number(row.seq);
      for (const item of parseStoredAttachments(row.attachments_json)) {
        attachmentIds.push(item.id);
      }
      this.ctx.storage.sql.exec(`DELETE FROM hidden_messages WHERE seq = ?`, seq);
      this.ctx.storage.sql.exec(`DELETE FROM messages WHERE seq = ? AND sent_at < ?`, seq, cutoff);
    }
    return uniqueAttachmentIds(attachmentIds, RETENTION_BATCH * 3);
  }

  private async notifyDirectoryTombstone(roomId: string, event: MessageDeletedEvent) {
    const latest = this.latestVisiblePreview();
    if (!latest) {
      await this.notifyDirectoryPreview(roomId, {
        seq: event.seq,
        preview: DIRECTORY_TOMBSTONE_PREVIEW,
        senderUserId: event.senderUserId,
        senderName: event.sender,
        senderRole: event.senderRole,
        sentAt: event.sentAt,
      });
      return;
    }
    await this.notifyDirectoryPreview(roomId, latest);
  }

  private async rememberRoomId(roomId: string) {
    const id = String(roomId || "").trim();
    if (!id) return;
    try {
      await this.ctx.storage.put("roomId", id);
    } catch {
      // local storage optional
    }
  }

  private async storedRoomId(): Promise<string> {
    try {
      return String((await this.ctx.storage.get("roomId")) || "").trim();
    } catch {
      return "";
    }
  }

  private queueAttachmentCleanup(roomId: string, attachmentIds: string[]) {
    const ids = uniqueAttachmentIds(attachmentIds, RETENTION_BATCH * 3);
    if (!roomId || ids.length === 0) return;
    for (let i = 0; i < ids.length; i += CHAT_ATTACHMENT_CLEANUP_BATCH) {
      const chunk = ids.slice(i, i + CHAT_ATTACHMENT_CLEANUP_BATCH);
      try {
        this.ctx.waitUntil(this.sendAttachmentCleanup(roomId, chunk));
      } catch {
        void this.sendAttachmentCleanup(roomId, chunk);
      }
    }
  }

  private async sendAttachmentCleanup(roomId: string, attachmentIds: string[]) {
    const url = nextInternalUrl(this.env, "/api/chat/attachments/cleanup");
    if (!url || !roomId || attachmentIds.length === 0) return;
    try {
      const headers = await internalAuthHeaders(
        chatInternalSecret(this.env),
        "/api/chat/attachments/cleanup"
      );
      const res = await fetch(url, {
        method: "POST",
        headers: { ...headers, ...nextAppExtraHeaders(this.env, url) },
        body: JSON.stringify({ roomId, attachmentIds }),
        ...nextAppFetchInit(this.env),
      });
      if (!res.ok) {
        console.error("[chat-photo] attachment cleanup request failed", {
          roomId,
          status: res.status,
          attachmentIds,
        });
      }
    } catch {
      console.error("[chat-photo] attachment cleanup request error", { roomId, attachmentIds });
    }
  }

  private async consumeChatAttachments(attachmentIds: string[]) {
    const consumeUrl = nextInternalUrl(this.env, "/api/chat/attachments/consume");
    if (!consumeUrl || attachmentIds.length === 0) return;
    try {
      const headers = await internalAuthHeaders(
        chatInternalSecret(this.env),
        "/api/chat/attachments/consume"
      );
      await fetch(consumeUrl, {
        method: "POST",
        headers: { ...headers, ...nextAppExtraHeaders(this.env, consumeUrl) },
        body: JSON.stringify({ attachmentIds }),
        ...nextAppFetchInit(this.env),
      });
    } catch {
      // persist already succeeded
    }
  }

  private queueChatPushDispatch(roomId: string, message: ChatMessage) {
    try {
      this.ctx.waitUntil(this.sendChatPushDispatch(roomId, message));
    } catch {
      void this.sendChatPushDispatch(roomId, message);
    }
  }

  private async sendChatPushDispatch(roomId: string, message: ChatMessage) {
    const url = nextPushDispatchUrl(this.env);
    if (!url || message.deletionType) return;
    try {
      let roomType = "ALL";
      let memberUserIds: number[] | null = null;
      if (isCustomRoomId(roomId)) {
        roomType = "CUSTOM";
        memberUserIds = (await listDirectoryMemberIds(this.env, roomId)) ?? [];
      } else if (isDmRoomId(roomId)) {
        roomType = "DM";
        memberUserIds = (await listDirectoryMemberIds(this.env, roomId)) ?? [];
      }
      const headers = await internalAuthHeaders(
        chatInternalSecret(this.env),
        "/api/chat/push-dispatch"
      );
      await fetch(url, {
        method: "POST",
        headers: { ...headers, ...nextAppExtraHeaders(this.env, url) },
        body: JSON.stringify({
          roomId,
          seq: message.seq || 0,
          senderUserId: message.senderUserId,
          senderName: message.sender,
          preview: directorySafePreview({
            body: message.body,
            deletionType: message.deletionType,
            attachments: message.attachments,
          }),
          mentionAll: message.mentionAll === true,
          mentionUserIds: (message.mentions || []).map((m) => m.userId),
          replyToSenderUserId:
            Number(message.replyTo?.senderUserId || 0) > 0
              ? message.replyTo?.senderUserId
              : null,
          roomType,
          memberUserIds,
          roomName: isAllRoomId(roomId) ? "전체 채팅방" : null,
        }),
        ...nextAppFetchInit(this.env),
      });
    } catch {
      // chat persist already succeeded
    }
  }

  private async notifyDirectoryMessage(roomId: string, message: ChatMessage) {
    await this.notifyDirectoryPreview(roomId, {
      seq: message.seq || 0,
      preview: directorySafePreview({
        body: message.body,
        deletionType: message.deletionType,
        attachments: message.attachments,
      }),
      senderUserId: message.senderUserId,
      senderName: message.sender,
      senderRole: message.senderRole,
      sentAt: message.sentAt,
    });
  }

  private async notifyDirectoryPreview(
    roomId: string,
    payload: {
      seq: number;
      preview: string;
      senderUserId: number;
      senderName: string;
      senderRole: string;
      sentAt: string;
    }
  ) {
    if (!isDirectoryRoomId(roomId)) return;
    try {
      const headers = await internalAuthHeaders(
        chatInternalSecret(this.env),
        "/internal/message"
      );
      await directoryStub(this.env).fetch(
        new Request("https://chat-directory/internal/message", {
          method: "POST",
          headers,
          body: JSON.stringify({
            roomId,
            seq: payload.seq,
            preview: payload.preview,
            senderUserId: payload.senderUserId,
            senderName: payload.senderName,
            senderRole: payload.senderRole,
            sentAt: payload.sentAt,
          }),
        })
      );
    } catch {
      // room message already committed
    }
  }

  private async notifyDirectoryRead(roomId: string, userId: number, seq: number) {
    if (!isDirectoryRoomId(roomId)) return;
    try {
      const headers = await internalAuthHeaders(
        chatInternalSecret(this.env),
        "/internal/read"
      );
      await directoryStub(this.env).fetch(
        new Request("https://chat-directory/internal/read", {
          method: "POST",
          headers,
          body: JSON.stringify({ roomId, userId, seq }),
        })
      );
    } catch {
      // ignore
    }
  }
}
