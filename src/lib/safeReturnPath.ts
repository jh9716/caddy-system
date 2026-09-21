/** open redirect 방지: 같은 origin 상대 경로만 */
export function safeReturnPath(input: unknown): string | null {
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  if (raw.includes("\\") || raw.includes("\n") || raw.includes("\r")) return null;
  return raw;
}
