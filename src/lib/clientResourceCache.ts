/**
 * Browser-memory stale-while-revalidate cache.
 * No localStorage / sessionStorage / IndexedDB / Cache Storage.
 * Keys are auth namespace + resource + params. Never tokens or cookies.
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

/** Freshness hint only — stale hits are still readable for SWR display. */
export const CLIENT_RESOURCE_TTL_MS: Record<ClientResourceName, number> = {
  [CLIENT_RESOURCE.BOARD]: 30_000,
  [CLIENT_RESOURCE.BOARD_COMMENTS]: 10_000,
  [CLIENT_RESOURCE.OFF_CALENDAR]: 30_000,
  [CLIENT_RESOURCE.DASHBOARD]: 15_000,
  [CLIENT_RESOURCE.CADDY_ROSTER]: 30_000,
  [CLIENT_RESOURCE.CADDY_SUMMARY]: 30_000,
  [CLIENT_RESOURCE.CADDY_MINE]: 30_000,
};

export type ClientResourceHit<T> = {
  value: T;
  storedAt: number;
  ageMs: number;
  fresh: boolean;
};

type StoreEntry = { value: unknown; storedAt: number };

const store = new Map<string, StoreEntry>();
let lastNamespace: ClientAuthNamespace | null = null;

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

export function clearClientResourceCache(): void {
  store.clear();
  lastNamespace = null;
}

export function resetClientResourceCacheForTests(): void {
  clearClientResourceCache();
}

export function isClientResourceFresh(ageMs: number, ttlMs: number): boolean {
  return ageMs <= ttlMs;
}

export function readClientResource<T>(
  ns: ClientAuthNamespace,
  resource: string,
  params: string,
  nowMs: number = Date.now(),
  ttlMs?: number
): ClientResourceHit<T> | null {
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
  store.set(clientResourceStoreKey(ns, resource, params), {
    value,
    storedAt: nowMs,
  });
}

export function invalidateClientResource(
  ns: ClientAuthNamespace,
  resource: string,
  params?: string
): void {
  if (params != null) {
    store.delete(clientResourceStoreKey(ns, resource, params));
    return;
  }
  const prefix = `${authNamespaceKey(ns)}::${resource}::`;
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
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
