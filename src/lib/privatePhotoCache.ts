import { createHash } from "node:crypto";

/** Store is allowed; every reuse must revalidate with the origin. */
export const PRIVATE_PHOTO_CACHE_CONTROL = "private, no-cache";

export type PrivatePhotoCacheKind = "n" | "r";

export type PrivatePhotoCacheMeta = {
  id: number;
  size: number;
  storageKey: string;
};

/**
 * Strong ETag from DB metadata only. storageKey is hashed, never sent raw.
 */
export function buildPrivatePhotoETag(
  kind: PrivatePhotoCacheKind,
  meta: PrivatePhotoCacheMeta
): string {
  const digest = createHash("sha256")
    .update(`v1:${kind}:${meta.id}:${meta.size}:${meta.storageKey}`)
    .digest("hex")
    .slice(0, 12);
  return `"${kind}${meta.id}-${meta.size}-${digest}"`;
}

export function ifNoneMatchContains(
  header: string | null | undefined,
  etag: string
): boolean {
  if (!header || !etag) return false;
  const want = etag.trim();
  return header.split(",").some((part) => {
    const token = part.trim();
    if (!token || token === "*") return false;
    return token === want || token === `W/${want}`;
  });
}

export function privatePhotoCacheHeaders(
  etag: string,
  mimeType?: string
): Record<string, string> {
  const headers: Record<string, string> = {
    "Cache-Control": PRIVATE_PHOTO_CACHE_CONTROL,
    ETag: etag,
    "X-Content-Type-Options": "nosniff",
  };
  if (mimeType) headers["Content-Type"] = mimeType;
  return headers;
}
