/**
 * Draft/JSON 예약 안정 identity.
 * 위치(course/shift/teeTime)에 의존하지 않는 uid를 부여해
 * MOVE 이후에도 같은 예약을 추적한다. DB schema/migration 없음.
 */

export type ReservationIdentityFields = {
  id?: string | number;
  uid?: string;
  date?: string;
  course?: string;
  shift?: string;
  teeTime?: string;
  rawRowIndex?: number;
  teamName?: string | null;
  sourceSheet?: string;
};

const ID_PREFIX = "id:";
const UID_PREFIX = "uid:";

function trimStr(value: unknown): string {
  return String(value ?? "").trim();
}

function sanitizeIdentityPart(value: unknown): string {
  const raw = trimStr(value);
  if (!raw) return "_";
  return raw.replace(/[|:]+/g, "_").replace(/\s+/g, "_").slice(0, 80);
}

export function reservationHasPersistentId(
  r: Pick<ReservationIdentityFields, "id">
): boolean {
  return r.id != null && trimStr(r.id) !== "";
}

export function reservationUidValue(
  r: Pick<ReservationIdentityFields, "uid">
): string {
  const raw = trimStr(r.uid);
  if (!raw) return "";
  return raw.startsWith(UID_PREFIX) ? raw.slice(UID_PREFIX.length) : raw;
}

/** 위치 포함 레거시 키. 이동 전 source lookup / 기존 Draft 호환용. */
export function legacyCompositeReservationKey(
  r: ReservationIdentityFields
): string {
  return [
    r.date ?? "",
    r.course ?? "",
    r.shift ?? "",
    r.teeTime ?? "",
    r.rawRowIndex ?? "",
    r.teamName ?? "",
    r.sourceSheet ?? "",
  ].join("|");
}

/**
 * 예약 추적 키.
 * 1) DB/합성 id → id:<id>
 * 2) Draft uid → uid:<uid>  (위치 비의존)
 * 3) 레거시 composite (위치 포함, 이동 identity로 쓰지 않음)
 */
export function reservationKey(r: ReservationIdentityFields): string {
  if (reservationHasPersistentId(r)) return `${ID_PREFIX}${trimStr(r.id)}`;
  const uid = reservationUidValue(r);
  if (uid) return `${UID_PREFIX}${uid}`;
  return legacyCompositeReservationKey(r);
}

/** `id:` 또는 `uid:` 이고 위치가 들어간 `|` 가 없는 키만 이동 identity로 허용. */
export function isStableReservationMoveKey(key: unknown): boolean {
  const raw = trimStr(key);
  if (!raw || raw.includes("|")) return false;
  if (raw.startsWith(ID_PREFIX)) return raw.slice(ID_PREFIX.length).length > 0;
  if (raw.startsWith(UID_PREFIX)) return raw.slice(UID_PREFIX.length).length > 0;
  return false;
}

export function stableReservationMoveKeyFromId(
  id: string | number
): string | null {
  const raw = trimStr(id);
  if (!raw || raw.includes("|")) return null;
  return `${ID_PREFIX}${raw}`;
}

/**
 * Excel/JSON origin 기반 결정적 uid.
 * date + sourceSheet + rawRowIndex 만 사용 (course/time/shift 제외).
 */
export function deriveReservationUid(r: ReservationIdentityFields): string {
  const date = sanitizeIdentityPart(r.date);
  const sheet = sanitizeIdentityPart(r.sourceSheet);
  const row =
    r.rawRowIndex != null && Number.isFinite(Number(r.rawRowIndex))
      ? String(r.rawRowIndex)
      : "_";
  if (sheet !== "_" || row !== "_") {
    return `xlsx.${date}.${sheet}.${row}`;
  }
  const team = sanitizeIdentityPart(r.teamName);
  return `anon.${date}.${team}`;
}

export function ensureReservationUid<T extends ReservationIdentityFields>(
  reservation: T,
  used?: Set<string>
): T {
  const existing = reservationKey(reservation);
  if (isStableReservationMoveKey(existing)) {
    used?.add(existing);
    return reservation;
  }
  let uid = deriveReservationUid(reservation);
  let key = `${UID_PREFIX}${uid}`;
  let n = 0;
  while (used?.has(key)) {
    n += 1;
    uid = `${deriveReservationUid(reservation)}.${n}`;
    key = `${UID_PREFIX}${uid}`;
  }
  used?.add(key);
  if (reservationUidValue(reservation) === uid) return reservation;
  return { ...reservation, uid };
}

export function stampReservationIdentities<T extends ReservationIdentityFields>(
  reservations: readonly T[]
): T[] {
  const used = new Set<string>();
  return reservations.map((row) => ensureReservationUid(row, used));
}

export function reservationMatchesIdentity(
  reservation: ReservationIdentityFields,
  key?: string | null,
  id?: string | number | null
): boolean {
  if (id != null && trimStr(id) !== "") {
    if (reservationHasPersistentId(reservation) && trimStr(reservation.id) === trimStr(id)) {
      return true;
    }
    if (reservationKey(reservation) === trimStr(id)) return true;
  }
  const want = trimStr(key);
  if (!want) return false;
  if (reservationKey(reservation) === want) return true;
  if (legacyCompositeReservationKey(reservation) === want) return true;
  return false;
}
