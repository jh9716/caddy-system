/** ScheduleExtraTag.createdBy is a display string. Never take it from the client. */

export function scheduleExtraTagCreatedBy(
  auth: { username?: string | null } | null | undefined
): string | null {
  const username = String(auth?.username ?? "").trim();
  return username || null;
}
