/**
 * In-memory FCM token arrival. Registration events resolve waiters.
 * No web storage. No permission request.
 */

export type NativePushTokenArrivalGate = {
  read(): string | null;
  remember(token: string): string | null;
  wait(timeoutMs: number): Promise<string | null>;
  clear(): void;
};

export function createNativePushTokenArrivalGate(): NativePushTokenArrivalGate {
  let token: string | null = null;
  const waiters = new Set<(next: string | null) => void>();

  function notify(next: string | null) {
    const pending = [...waiters];
    waiters.clear();
    for (const resolve of pending) resolve(next);
  }

  return {
    read() {
      return token;
    },
    remember(raw: string) {
      const next = String(raw ?? "").trim();
      token = next || null;
      if (token) notify(token);
      return token;
    },
    wait(timeoutMs: number) {
      if (token) return Promise.resolve(token);
      const ms = Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : 0;
      return new Promise<string | null>((resolve) => {
        let settled = false;
        const finish = (next: string | null) => {
          if (settled) return;
          settled = true;
          waiters.delete(finish);
          clearTimeout(timer);
          resolve(next);
        };
        const timer = setTimeout(() => finish(token), ms);
        waiters.add(finish);
      });
    },
    clear() {
      token = null;
      notify(null);
    },
  };
}

/** Logout: use memory token, else one short granted-token wait. Never hangs. */
export async function resolveLogoutNativePushToken(input: {
  memoryToken: string | null;
  acquireIfGranted: () => Promise<string | null>;
}): Promise<string | null> {
  const existing = String(input.memoryToken ?? "").trim();
  if (existing) return existing;
  try {
    return String((await input.acquireIfGranted()) ?? "").trim() || null;
  } catch {
    return null;
  }
}
