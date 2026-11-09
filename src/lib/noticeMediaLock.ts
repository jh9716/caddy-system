import type { Prisma } from "@prisma/client";

/** Serialize notice photo/file row inserts so parallel uploads keep order and limits. */
export async function lockNoticeRow(
  tx: Prisma.TransactionClient,
  noticeId: number
): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: number }>>`
    SELECT id FROM "Notice" WHERE id = ${noticeId} FOR UPDATE
  `;
  return rows.length > 0;
}

export function parseRequestedSortOrder(value: FormDataEntryValue | null | undefined): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 10_000) return null;
  return n;
}

export function resolveLockedSortOrder(
  maxExisting: number | null | undefined,
  requested: number | null | undefined,
  taken: boolean
): number {
  const fallback = (maxExisting ?? -1) + 1;
  if (requested == null || taken) return fallback;
  return requested;
}
