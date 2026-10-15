import { parseDmRoomId } from "./protocol";

export type CanonicalDmRejectError =
  | "invalid_room"
  | "invalid_dm_members"
  | "dm_pair_mismatch"
  | "dm_owner_mismatch"
  | "room_exists";

export type CanonicalDmPlan =
  | { action: "reject"; error: CanonicalDmRejectError; status: 400 | 409 }
  | { action: "create"; pair: [number, number] }
  | { action: "repair"; pair: [number, number]; add: number[] }
  | { action: "idempotent"; pair: [number, number] };

export function uniquePositiveUserIds(raw: Iterable<unknown>): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const value of raw) {
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Valid HMAC create grant + canonical pair is enough to ensure both members.
 * Never adds a third party. Never rewrites a non-DM room.
 */
export function planCanonicalDmCreate(input: {
  roomId: string;
  ownerUserId: number;
  grantMemberIds: Iterable<unknown>;
  existingType: string | null | undefined;
  existingMemberIds: Iterable<unknown>;
}): CanonicalDmPlan {
  const pair = parseDmRoomId(input.roomId);
  if (!pair) return { action: "reject", error: "invalid_room", status: 400 };

  const grantIds = uniquePositiveUserIds(input.grantMemberIds);
  if (grantIds.length !== 2) {
    return { action: "reject", error: "invalid_dm_members", status: 400 };
  }
  const [grantLow, grantHigh] =
    grantIds[0]! < grantIds[1]!
      ? [grantIds[0]!, grantIds[1]!]
      : [grantIds[1]!, grantIds[0]!];
  if (grantLow !== pair.low || grantHigh !== pair.high) {
    return { action: "reject", error: "dm_pair_mismatch", status: 400 };
  }

  const owner = Number(input.ownerUserId);
  if (owner !== pair.low && owner !== pair.high) {
    return { action: "reject", error: "dm_owner_mismatch", status: 400 };
  }

  if (input.existingType) {
    if (String(input.existingType) !== "DM") {
      return { action: "reject", error: "room_exists", status: 409 };
    }
    const existing = new Set(uniquePositiveUserIds(input.existingMemberIds));
    const add = [pair.low, pair.high].filter((id) => !existing.has(id));
    if (add.length === 0) {
      return { action: "idempotent", pair: [pair.low, pair.high] };
    }
    return { action: "repair", pair: [pair.low, pair.high], add };
  }

  return { action: "create", pair: [pair.low, pair.high] };
}
