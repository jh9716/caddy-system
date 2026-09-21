/**
 * Notification tap → in-app path. Same-origin relative URLs only.
 */
import { safeReturnPath } from "@/lib/safeReturnPath";

export function resolveNativePushOpenPath(input: unknown): string | null {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const rec = input as { url?: unknown; path?: unknown; data?: unknown };
    return (
      safeReturnPath(rec.url) ??
      safeReturnPath(rec.path) ??
      resolveNativePushOpenPath(rec.data)
    );
  }
  return safeReturnPath(input);
}

export function assignNativePushPath(
  path: string | null,
  assign: (href: string) => void
): boolean {
  if (!path) return false;
  assign(path);
  return true;
}
