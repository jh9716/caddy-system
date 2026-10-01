/**
 * Browser-memory stale-while-revalidate cache.
 * No localStorage / sessionStorage / IndexedDB / Cache Storage.
 * Keys are auth namespace + resource + params. Never tokens or cookies.
 *
 * The Map is browser-tab memory only. SSR / Node must not retain entries
 * so request A/B cannot share a process-level store.
 */

import { isCurrentLoadGen } from "@/lib/pendingLoad";

export type ClientAuthNamespace = {
  userId: number | null;
  username: string;
  role: string;
  sessionVersion: number;
};

export const CLIENT_RESOURCE = {
  BOARD: "board",
  BOARD_COMMENTS: "board-comments",
  OFF_CALENDAR: "off-calendar",
  DASHBOARD: "dashboard",
  CADDY_ROSTER: "caddy-roster",
  CADDY_SUMMARY: "caddy-summary",
  CADDY_MINE: "caddy-mine",
} as const;

export type ClientResourceName =
  (typeof CLIENT_RESOURCE)[keyof typeof CLIENT_RESOURCE];

/** Freshness hint: fresh hits skip the resource API after /api/me confirms. */
export const CLIENT_RESOURCE_TTL_MS: Record<ClientResourceName, number> = {
  [CLIENT_RESOURCE.BOARD]: 30_000,
  [CLIENT_RESOURCE.BOARD_COMMENTS]: 10_000,
  [CLIENT_RESOURCE.OFF_CALENDAR]: 30_000,
  [CLIENT_RESOURCE.DASHBOARD]: 15_000,
  [CLIENT_RESOURCE.CADDY_ROSTER]: 30_000,
  [CLIENT_RESOURCE.CADDY_SUMMARY]: 30_000,
  [CLIENT_RESOURCE.CADDY_MINE]: 30_000,
};

/** Hard memory cap — not a display expire. Refresh still drops everything. */
export const CLIENT_RESOURCE_MAX_ENTRIES = 64;
export const CLIENT_RESOURCE_MAX_AGE_MS = 30 * 60 * 1000;
export const CLIENT_RESOURCE_AUTH_CHANNEL = "verthill-client-resource-cache";

export type ClientResourceHit<T> = {
  value: T;
  storedAt: number;
  ageMs: number;
  fresh: boolean;
};

type StoreEntry = { value: unknown; storedAt: number };

let browserStore: Map<string, StoreEntry> | null = null;
let nodeTestStore: Map<string, StoreEntry> | null = null;
let lastNamespace: ClientAuthNamespace | null = null;
const inflight = new Map<string, Promise<unknown>>();
let applyingRemoteClear = false;
let authChannel: BroadcastChannel | null = null;
let authChannelInstalled = false;

function isBrowserRuntime(): boolean {
  return typeof window !== "undefined";
}

function getStore(): Map<string, StoreEntry> | null {
  if (isBrowserRuntime()) {
    if (!browserStore) browserStore = new Map();
    return browserStore;
  }
  return nodeTestStore;
}

export function isClientResourceCacheServerIdle(): boolean {
  return !isBrowserRuntime() && nodeTestStore == null;
}

export function authNamespaceKey(ns: ClientAuthNamespace): string {
  const userId = ns.userId == null ? "nouser" : String(ns.userId);
  return `${userId}|${ns.role}|${ns.sessionVersion}|${ns.username}`;
}

export function sameAuthNamespace(
  a: ClientAuthNamespace | null,
  b: ClientAuthNamespace | null
): boolean {
  if (!a || !b) return false;
  return authNamespaceKey(a) === authNamespaceKey(b);
}

export function clientResourceStoreKey(
  ns: ClientAuthNamespace,
  resource: string,
  params: string
): string {
  return `${authNamespaceKey(ns)}::${resource}::${params}`;
}

export function rememberClientAuthNamespace(ns: ClientAuthNamespace): void {
  lastNamespace = ns;
}

export function readLastClientAuthNamespace(): ClientAuthNamespace | null {
  return lastNamespace;
}

function wipeLocalCache(): void {
  getStore()?.clear();
  lastNamespace = null;
  inflight.clear();
}

function postAuthCacheClear(): void {
  if (applyingRemoteClear || !isBrowserRuntime()) return;
  try {
    getAuthChannel()?.postMessage({ type: "clear" });
  } catch {
    /* ignore */
  }
}

export function clearClientResourceCache(): void {
  wipeLocalCache();
  postAuthCacheClear();
}

export function applyRemoteClientResourceCacheClear(): void {
  applyingRemoteClear = true;
  try {
    wipeLocalCache();
  } finally {
    applyingRemoteClear = false;
  }
}

export function resetClientResourceCacheForTests(): void {
  applyingRemoteClear = false;
  lastNamespace = null;
  inflight.clear();
  browserStore = null;
  nodeTestStore = new Map();
}

/** Leave the Node store unset so SSR/server idle can be asserted. */
export function releaseClientResourceCacheStoreForTests(): void {
  applyingRemoteClear = false;
  lastNamespace = null;
  inflight.clear();
  browserStore = null;
  nodeTestStore = null;
}

export function isClientResourceFresh(ageMs: number, ttlMs: number): boolean {
  return ageMs <= ttlMs;
}

export function shouldSkipFreshResourceRefresh(
  hit: ClientResourceHit<unknown> | null | undefined
): boolean {
  return Boolean(hit?.fresh);
}

function pruneStore(nowMs: number): void {
  const store = getStore();
  if (!store) return;
  for (const [key, entry] of store) {
    if (nowMs - entry.storedAt > CLIENT_RESOURCE_MAX_AGE_MS) {
      store.delete(key);
    }
  }
  if (store.size <= CLIENT_RESOURCE_MAX_ENTRIES) return;
  const oldest = [...store.entries()].sort((a, b) => a[1].storedAt - b[1].storedAt);
  for (const [key] of oldest) {
    if (store.size <= CLIENT_RESOURCE_MAX_ENTRIES) break;
    store.delete(key);
  }
}

export function readClientResource<T>(
  ns: ClientAuthNamespace,
  resource: string,
  params: string,
  nowMs: number = Date.now(),
  ttlMs?: number
): ClientResourceHit<T> | null {
  const store = getStore();
  if (!store) return null;
  const entry = store.get(clientResourceStoreKey(ns, resource, params));
  if (!entry) return null;
  const ageMs = Math.max(0, nowMs - entry.storedAt);
  const ttl = ttlMs ?? CLIENT_RESOURCE_TTL_MS[resource as ClientResourceName] ?? 0;
  return {
    value: entry.value as T,
    storedAt: entry.storedAt,
    ageMs,
    fresh: isClientResourceFresh(ageMs, ttl),
  };
}

export function peekLastNamespaceResource<T>(
  resource: string,
  params: string,
  matches?: (value: T) => boolean
): ClientResourceHit<T> | null {
  const ns = lastNamespace;
  if (!ns) return null;
  const hit = readClientResource<T>(ns, resource, params);
  if (!hit) return null;
  if (matches && !matches(hit.value)) return null;
  return hit;
}

export function writeClientResource<T>(
  ns: ClientAuthNamespace,
  resource: string,
  params: string,
  value: T,
  nowMs: number = Date.now()
): void {
  const store = getStore();
  if (!store) return;
  pruneStore(nowMs);
  store.set(clientResourceStoreKey(ns, resource, params), {
    value,
    storedAt: nowMs,
  });
  pruneStore(nowMs);
}

export function invalidateClientResource(
  ns: ClientAuthNamespace,
  resource: string,
  params?: string
): void {
  const store = getStore();
  if (!store) return;
  if (params != null) {
    store.delete(clientResourceStoreKey(ns, resource, params));
    return;
  }
  const prefix = `${authNamespaceKey(ns)}::${resource}::`;
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}

export function runDedupedClientResource<T>(
  key: string,
  run: () => Promise<T>
): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;
  const pending = run().finally(() => {
    if (inflight.get(key) === pending) inflight.delete(key);
  });
  inflight.set(key, pending);
  return pending;
}

export function shouldApplyScopedResponse(input: {
  requestGen: number;
  latestGen: number;
  selectedKey: string;
  responseKey: string;
}): boolean {
  return (
    isCurrentLoadGen(input.requestGen, input.latestGen) &&
    input.selectedKey === input.responseKey
  );
}

type MeUser = {
  id?: unknown;
  username?: unknown;
  role?: unknown;
  sessionVersion?: unknown;
};

export function clientAuthNamespaceFromMeUser(
  user: MeUser | null | undefined
): ClientAuthNamespace | null {
  if (!user) return null;
  const role = String(user.role ?? "").trim();
  if (!role) return null;
  return {
    userId: typeof user.id === "number" ? user.id : null,
    username: String(user.username ?? ""),
    role,
    sessionVersion: Number(user.sessionVersion ?? 0),
  };
}

/**
 * Confirm the signed-in user via GET /api/me.
 * Mismatched sessionVersion / user / role drops the previous namespace.
 */
export async function ensureClientAuthNamespace(): Promise<ClientAuthNamespace | null> {
  try {
    const res = await fetch("/api/me", {
      credentials: "include",
      cache: "no-store",
    });
    if (res.status === 401 || res.status === 403) {
      clearClientResourceCache();
      return null;
    }
    const json = (await res.json().catch(() => null)) as {
      authenticated?: boolean;
      user?: MeUser;
    } | null;
    if (!json?.authenticated) {
      clearClientResourceCache();
      return null;
    }
    const next = clientAuthNamespaceFromMeUser(json.user);
    if (!next) {
      clearClientResourceCache();
      return null;
    }
    if (lastNamespace && !sameAuthNamespace(lastNamespace, next)) {
      clearClientResourceCache();
    }
    rememberClientAuthNamespace(next);
    return next;
  } catch {
    return lastNamespace;
  }
}

function getAuthChannel(): BroadcastChannel | null {
  if (!isBrowserRuntime() || typeof BroadcastChannel === "undefined") return null;
  if (!authChannel) {
    authChannel = new BroadcastChannel(CLIENT_RESOURCE_AUTH_CHANNEL);
  }
  return authChannel;
}

function reloadAfterRemoteAuthClear(): void {
  if (!isBrowserRuntime()) return;
  try {
    location.reload();
  } catch {
    /* ignore */
  }
}

export function installClientResourceCacheRuntime(): void {
  if (authChannelInstalled || !isBrowserRuntime()) return;
  authChannelInstalled = true;
  const channel = getAuthChannel();
  if (channel) {
    channel.onmessage = (event: MessageEvent) => {
      const type = (event.data as { type?: string } | null)?.type;
      if (type !== "clear") return;
      applyRemoteClientResourceCacheClear();
      reloadAfterRemoteAuthClear();
    };
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    const prev = lastNamespace;
    if (!prev) return;
    void ensureClientAuthNamespace().then((next) => {
      if (!next || !sameAuthNamespace(prev, next)) {
        applyRemoteClientResourceCacheClear();
        reloadAfterRemoteAuthClear();
      }
    });
  });
}

if (typeof window !== "undefined") {
  installClientResourceCacheRuntime();
}
