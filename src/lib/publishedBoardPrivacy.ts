/**
 * Published 배치표 조회 응답용 privacy.
 * DB Published payload는 수정하지 않고, GET serialization에서만 복사본을 만든다.
 */

import type {
  DailyBoardPublishedPayloadV1,
  PublishedPlacementV1,
} from "@/lib/dailyBoardPublished";
import type { AppRole } from "@/lib/sessionCookies";

/** admin·leader(조장)는 운영 조회. caddy/staff 및 미확인 role은 고객 식별 필드 제거. */
export function shouldRedactPublishedGuestNames(
  role: AppRole | null | undefined
): boolean {
  return role !== "admin" && role !== "leader";
}

export function redactPublishedPlacementGuestNames(
  row: PublishedPlacementV1
): PublishedPlacementV1 {
  const { reservationId: _id, reservationKey: _key, ...rest } = row;
  return { ...rest, teamName: null } as PublishedPlacementV1;
}

export function redactPublishedPayloadGuestNames(
  payload: DailyBoardPublishedPayloadV1
): DailyBoardPublishedPayloadV1 {
  return {
    ...payload,
    placements: payload.placements.map(redactPublishedPlacementGuestNames),
  };
}

export function publishedPayloadForReader(
  payload: DailyBoardPublishedPayloadV1,
  role: AppRole | null | undefined
): DailyBoardPublishedPayloadV1 {
  return shouldRedactPublishedGuestNames(role)
    ? redactPublishedPayloadGuestNames(payload)
    : payload;
}
