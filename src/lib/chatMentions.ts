import { isDmRoomId } from "@/lib/chatRooms";

export const MAX_MENTIONS = 20;
export const MAX_MENTION_RAW = 100;
export const MENTION_ALL_LABEL = "전체";
export const MENTION_SUGGEST_LIMIT = 8;

export type ChatMention = { userId: number };

export type ComposerMention = {
  userId: number;
  label: string;
};

export type MentionCandidate = {
  userId: number;
  displayName: string;
  team: string;
  role: string;
};

export type MentionSuggestion = MentionCandidate & {
  kind: "user" | "all";
  secondary: string;
};

export function canMentionAll(role: string | null | undefined): boolean {
  return role === "admin" || role === "leader";
}

/** DM mention pool is the peer on the room summary. No directory listing. */
export function dmMentionCandidatesFromRoom(input: {
  roomId: string;
  myUserId: number;
  peerUserId?: number | null;
  peerDisplayName?: string | null;
  peerRole?: string | null;
  peerTeam?: string | null;
}): MentionCandidate[] {
  if (!isDmRoomId(String(input.roomId || ""))) return [];
  const peerUserId = Number(input.peerUserId);
  if (!Number.isInteger(peerUserId) || peerUserId <= 0) return [];
  if (peerUserId === input.myUserId) return [];
  return [
    {
      userId: peerUserId,
      displayName: String(input.peerDisplayName || "").trim() || "이름없음",
      team: String(input.peerTeam || "").trim() || "-",
      role: String(input.peerRole || "caddy"),
    },
  ];
}

export function normalizeMentionUserIds(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  if (raw.length > MAX_MENTION_RAW) return [];
  const out: number[] = [];
  const seen = new Set<number>();
  for (const item of raw) {
    const id =
      item != null && typeof item === "object" && "userId" in item
        ? Number((item as { userId: unknown }).userId)
        : Number(item);
    if (!Number.isInteger(id) || id <= 0) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_MENTIONS) break;
  }
  return out;
}

export function mentionsToWire(ids: number[]): ChatMention[] {
  return normalizeMentionUserIds(ids).map((userId) => ({ userId }));
}

export function resolveMentionAll(
  raw: unknown,
  senderRole: string | null | undefined
): boolean {
  return raw === true && canMentionAll(senderRole);
}

export function filterMentionsToMembers(
  ids: number[],
  memberIds: Iterable<number> | null | undefined
): number[] {
  if (memberIds == null) return normalizeMentionUserIds(ids);
  const allowed = new Set<number>();
  for (const id of memberIds) {
    if (Number.isInteger(id) && id > 0) allowed.add(id);
  }
  return normalizeMentionUserIds(ids).filter((id) => allowed.has(id));
}

export function mentionTokenBoundary(label: string): RegExp {
  const escaped = String(label ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`@${escaped}(?=$|[\\s.,!?…])`, "g");
}

export function countMentionNeedles(body: string, label: string): number {
  const text = String(body ?? "");
  if (!label) return 0;
  return (text.match(mentionTokenBoundary(label)) || []).length;
}

export function reconcileComposerMentions(
  body: string,
  tokens: ComposerMention[]
): ComposerMention[] {
  const kept: ComposerMention[] = [];
  const used = new Map<string, number>();
  const seen = new Set<number>();
  for (const token of tokens) {
    const label = String(token.label ?? "").trim();
    const userId = Number(token.userId);
    if (!label || !Number.isInteger(userId) || userId <= 0) continue;
    const available = countMentionNeedles(body, label);
    const already = used.get(label) ?? 0;
    if (already >= available) continue;
    if (seen.has(userId)) continue;
    used.set(label, already + 1);
    seen.add(userId);
    kept.push({ userId, label });
    if (kept.length >= MAX_MENTIONS) break;
  }
  return kept;
}

export function reconcileMentionAll(body: string, mentionAll: boolean): boolean {
  return mentionAll === true && countMentionNeedles(body, MENTION_ALL_LABEL) > 0;
}

export function mentionQueryAtCursor(
  text: string,
  cursor: number
): { start: number; query: string } | null {
  const value = String(text ?? "");
  const pos = Math.max(0, Math.min(Number(cursor) || 0, value.length));
  const before = value.slice(0, pos);
  const match = /@([^\s@]*)$/.exec(before);
  if (!match || match.index == null) return null;
  if (match.index > 0 && !/\s/.test(before.charAt(match.index - 1))) return null;
  return { start: match.index, query: match[1] || "" };
}

export function insertMentionToken(
  text: string,
  cursor: number,
  label: string
): { text: string; cursor: number } {
  const query = mentionQueryAtCursor(text, cursor);
  const inserted = `@${label} `;
  if (!query) {
    const next = `${String(text ?? "")}${inserted}`;
    return { text: next, cursor: next.length };
  }
  const next = `${text.slice(0, query.start)}${inserted}${text.slice(cursor)}`;
  return { text: next, cursor: query.start + inserted.length };
}

function mentionCandidateRank(role: string): number {
  if (role === "caddy") return 0;
  if (role === "leader") return 1;
  return 2;
}

export function compareMentionCandidates(
  a: Pick<MentionCandidate, "displayName" | "role" | "userId">,
  b: Pick<MentionCandidate, "displayName" | "role" | "userId">
): number {
  const rank = mentionCandidateRank(a.role) - mentionCandidateRank(b.role);
  if (rank !== 0) return rank;
  const name = a.displayName.localeCompare(b.displayName, "ko");
  if (name !== 0) return name;
  return a.userId - b.userId;
}

function matchesQuery(candidate: MentionCandidate, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    candidate.displayName.toLowerCase().includes(q) ||
    candidate.team.toLowerCase().includes(q) ||
    candidate.role.toLowerCase().includes(q)
  );
}

export function filterMentionSuggestions(input: {
  candidates: MentionCandidate[];
  query: string;
  canMentionAll: boolean;
}): MentionSuggestion[] {
  const query = String(input.query ?? "");
  const out: MentionSuggestion[] = [];
  if (
    input.canMentionAll &&
    (query === "" || MENTION_ALL_LABEL.startsWith(query) || MENTION_ALL_LABEL.includes(query))
  ) {
    out.push({
      userId: 0,
      displayName: MENTION_ALL_LABEL,
      team: "-",
      role: "all",
      kind: "all",
      secondary: "방 전체",
    });
  }
  const seen = new Set<number>();
  const names = new Map<string, number>();
  const candidates = [...input.candidates].sort(compareMentionCandidates);
  for (const row of candidates) {
    names.set(row.displayName, (names.get(row.displayName) ?? 0) + 1);
  }
  for (const row of candidates) {
    if (!Number.isInteger(row.userId) || row.userId <= 0) continue;
    if (seen.has(row.userId)) continue;
    if (!matchesQuery(row, query)) continue;
    seen.add(row.userId);
    const sameName = (names.get(row.displayName) ?? 0) > 1;
    out.push({
      ...row,
      kind: "user",
      secondary: sameName
        ? row.team !== "-"
          ? row.team
          : row.role
        : row.team !== "-"
          ? row.team
          : row.role === "admin"
            ? "관리자"
            : row.role === "leader"
              ? "리더"
              : "",
    });
    if (out.length >= MENTION_SUGGEST_LIMIT + (input.canMentionAll ? 1 : 0)) break;
  }
  return out.slice(0, MENTION_SUGGEST_LIMIT + (input.canMentionAll ? 1 : 0));
}

export type MentionBodyPart =
  | { kind: "text"; text: string }
  | { kind: "mention"; text: string; all: boolean };

type Range = { start: number; end: number; all: boolean };

export function splitMentionBody(
  body: string,
  input: {
    mentions: number[];
    mentionAll: boolean;
    nameByUserId: Map<number, string> | Record<number, string>;
  }
): MentionBodyPart[] {
  const text = String(body ?? "");
  const ranges: Range[] = [];
  const add = (start: number, end: number, all: boolean) => {
    if (start < 0 || end <= start) return;
    if (ranges.some((r) => !(end <= r.start || start >= r.end))) return;
    ranges.push({ start, end, all });
  };
  if (input.mentionAll) {
    const re = mentionTokenBoundary(MENTION_ALL_LABEL);
    let match: RegExpExecArray | null;
    while ((match = re.exec(text))) {
      add(match.index, match.index + match[0].length, true);
    }
  }
  const lookup =
    input.nameByUserId instanceof Map
      ? input.nameByUserId
      : new Map(
          Object.entries(input.nameByUserId).map(([k, v]) => [Number(k), String(v)])
        );
  for (const userId of normalizeMentionUserIds(input.mentions)) {
    const name = String(lookup.get(userId) || "").trim();
    if (!name) continue;
    const re = mentionTokenBoundary(name);
    let match: RegExpExecArray | null;
    while ((match = re.exec(text))) {
      add(match.index, match.index + match[0].length, false);
    }
  }
  ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  const parts: MentionBodyPart[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start < cursor) continue;
    if (range.start > cursor) {
      parts.push({ kind: "text", text: text.slice(cursor, range.start) });
    }
    parts.push({
      kind: "mention",
      text: text.slice(range.start, range.end),
      all: range.all,
    });
    cursor = range.end;
  }
  if (cursor < text.length) parts.push({ kind: "text", text: text.slice(cursor) });
  if (parts.length === 0) parts.push({ kind: "text", text });
  return parts;
}

export function isSelfMentioned(input: {
  myUserId: number | null | undefined;
  mentions: number[];
  mentionAll: boolean;
  senderUserId?: number | null;
}): boolean {
  const me = Number(input.myUserId);
  if (!Number.isInteger(me) || me <= 0) return false;
  if (Number(input.senderUserId) === me) return false;
  if (input.mentionAll) return true;
  return normalizeMentionUserIds(input.mentions).includes(me);
}
