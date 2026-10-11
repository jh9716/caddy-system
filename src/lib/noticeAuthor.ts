/**
 * Notice author display + server-side create snapshot.
 * Client-supplied author is ignored. No User FK. No username exposure.
 */

export const NOTICE_AUTHOR_FALLBACK = "관리자";
export const NOTICE_AUTHOR_MAX = 64;

export type NoticeAuthorAuth = {
  caddyId: number | null;
};

export type NoticeAuthorCaddyDb = {
  caddy: {
    findUnique: (args: {
      where: { id: number };
      select: { name: true };
    }) => Promise<{ name: string | null } | null>;
  };
};

export function formatNoticeAuthorDisplay(
  author: string | null | undefined
): string {
  const name = String(author ?? "").trim();
  return name || NOTICE_AUTHOR_FALLBACK;
}

export function resolveNoticeAuthorDisplayName(input: {
  caddyName?: string | null;
}): string {
  const name = String(input.caddyName ?? "").trim();
  if (!name) return NOTICE_AUTHOR_FALLBACK;
  return name.slice(0, NOTICE_AUTHOR_MAX);
}

export async function resolveNoticeAuthorForAuth(
  db: NoticeAuthorCaddyDb,
  auth: NoticeAuthorAuth | null | undefined
): Promise<string> {
  const caddyId = auth?.caddyId ?? null;
  if (caddyId == null || !Number.isInteger(caddyId) || caddyId <= 0) {
    return NOTICE_AUTHOR_FALLBACK;
  }
  const caddy = await db.caddy.findUnique({
    where: { id: caddyId },
    select: { name: true },
  });
  return resolveNoticeAuthorDisplayName({ caddyName: caddy?.name });
}
