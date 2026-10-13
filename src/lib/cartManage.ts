/**
 * 카트 마스터 검증 (순수 함수). 날짜 배정/가용 판정 없음.
 * autoAssignEngine 과 분리.
 */

import { isOperationalEmploymentStatus } from "@/lib/operationalRoster";

export const CART_KINDS = ["STANDARD", "OTHER"] as const;
export type CartKind = (typeof CART_KINDS)[number];

export const CART_OPERATIONAL_STATUSES = [
  "ACTIVE",
  "MAINTENANCE",
  "DISABLED",
] as const;
export type CartOperationalStatus = (typeof CART_OPERATIONAL_STATUSES)[number];

export const CART_KIND_LABELS: Record<CartKind, string> = {
  STANDARD: "일반",
  OTHER: "기타",
};

export const CART_STATUS_LABELS: Record<CartOperationalStatus, string> = {
  ACTIVE: "운행",
  MAINTENANCE: "정비",
  DISABLED: "사용중지",
};

export const CART_NUMBER_MAX = 16;
export const CART_TEXT_MAX = 80;

export class CartManageError extends Error {
  status = 400;
  code = "cart_invalid";
  constructor(message: string, code?: string, status?: number) {
    super(message);
    this.name = "CartManageError";
    if (code) this.code = code;
    if (status) this.status = status;
  }
}

export function isCartKind(value: unknown): value is CartKind {
  return (CART_KINDS as readonly string[]).includes(String(value ?? ""));
}

export function isCartOperationalStatus(
  value: unknown
): value is CartOperationalStatus {
  return (CART_OPERATIONAL_STATUSES as readonly string[]).includes(
    String(value ?? "")
  );
}

export function normalizeCartNumber(input: unknown): string {
  const raw = String(input ?? "").trim();
  if (!raw) {
    throw new CartManageError("카트 번호는 필수입니다.", "cart_number_required");
  }
  if (raw.length > CART_NUMBER_MAX) {
    throw new CartManageError(
      `카트 번호는 ${CART_NUMBER_MAX}자 이내여야 합니다.`,
      "cart_number_too_long"
    );
  }
  if (/\s/.test(raw)) {
    throw new CartManageError(
      "카트 번호에 공백을 넣을 수 없습니다.",
      "cart_number_invalid"
    );
  }
  return raw;
}

export function normalizeOptionalText(
  input: unknown,
  field: string
): string | null {
  if (input == null) return null;
  const raw = String(input).trim();
  if (!raw) return null;
  if (raw.length > CART_TEXT_MAX) {
    throw new CartManageError(
      `${field}는 ${CART_TEXT_MAX}자 이내여야 합니다.`,
      "cart_text_too_long"
    );
  }
  return raw;
}

export function parseOptionalOwnerCaddyId(input: unknown): number | null {
  if (input == null || input === "") return null;
  const id = Number(input);
  if (!Number.isInteger(id) || id < 1) {
    throw new CartManageError(
      "고정 주인 캐디가 올바르지 않습니다.",
      "cart_owner_invalid"
    );
  }
  return id;
}

export function parseCartKind(input: unknown): CartKind {
  if (input == null || input === "") return "STANDARD";
  if (!isCartKind(input)) {
    throw new CartManageError("카트 종류가 올바르지 않습니다.", "cart_kind_invalid");
  }
  return input;
}

export function parseCartOperationalStatus(
  input: unknown
): CartOperationalStatus {
  if (input == null || input === "") return "ACTIVE";
  if (!isCartOperationalStatus(input)) {
    throw new CartManageError(
      "카트 상태가 올바르지 않습니다.",
      "cart_status_invalid"
    );
  }
  return input;
}

export function parseDormitoryOnly(input: unknown): boolean {
  if (input == null) return false;
  if (typeof input !== "boolean") {
    throw new CartManageError(
      "기숙사 전용 값이 올바르지 않습니다.",
      "cart_dormitory_invalid"
    );
  }
  return input;
}

export function assertCartOwnerDormitoryXor(input: {
  dormitoryOnly: boolean;
  ownerCaddyId: number | null;
}): void {
  if (input.dormitoryOnly && input.ownerCaddyId != null) {
    throw new CartManageError(
      "기숙사 전용 카트에는 고정 주인을 지정할 수 없습니다.",
      "cart_dorm_owner_conflict"
    );
  }
}

export function isEligibleCartOwner(employmentStatus: unknown): boolean {
  return isOperationalEmploymentStatus(employmentStatus);
}

export function assertEligibleCartOwner(row: {
  id?: number;
  employmentStatus?: unknown;
} | null): void {
  if (!row) {
    throw new CartManageError(
      "고정 주인 캐디를 찾을 수 없습니다.",
      "cart_owner_not_found",
      404
    );
  }
  if (!isEligibleCartOwner(row.employmentStatus)) {
    throw new CartManageError(
      "고정 주인은 운영 중인 캐디만 지정할 수 있습니다.",
      "cart_owner_not_operational"
    );
  }
}

export function compareCartNumber(a: string, b: string): number {
  return String(a).localeCompare(String(b), "ko", { numeric: true });
}

export function cartOwnerPublic(row: {
  id: number;
  name: string;
  team: string;
  employmentStatus: string;
} | null | undefined) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    team: row.team,
    employmentStatus: row.employmentStatus,
  };
}

export type CartWriteInput = {
  number: string;
  kind: CartKind;
  kindLabel: string | null;
  ownerCaddyId: number | null;
  dormitoryOnly: boolean;
  operationalStatus: CartOperationalStatus;
  note: string | null;
};

export function resolveCartCreateInput(body: Record<string, unknown>): CartWriteInput {
  const dormitoryOnly = parseDormitoryOnly(body.dormitoryOnly);
  const ownerCaddyId = parseOptionalOwnerCaddyId(body.ownerCaddyId);
  assertCartOwnerDormitoryXor({ dormitoryOnly, ownerCaddyId });
  return {
    number: normalizeCartNumber(body.number),
    kind: parseCartKind(body.kind),
    kindLabel: normalizeOptionalText(body.kindLabel, "종류 설명"),
    ownerCaddyId,
    dormitoryOnly,
    operationalStatus: parseCartOperationalStatus(body.operationalStatus),
    note: normalizeOptionalText(body.note, "메모"),
  };
}

export function resolveCartPatchInput(
  body: Record<string, unknown>,
  current: {
    number: string;
    kind: CartKind | string;
    kindLabel?: string | null;
    ownerCaddyId?: number | null;
    dormitoryOnly: boolean;
    operationalStatus: CartOperationalStatus | string;
    note?: string | null;
  }
): CartWriteInput {
  const hasDorm = Object.prototype.hasOwnProperty.call(body, "dormitoryOnly");
  const hasOwner = Object.prototype.hasOwnProperty.call(body, "ownerCaddyId");
  const dormitoryOnly = hasDorm
    ? parseDormitoryOnly(body.dormitoryOnly)
    : current.dormitoryOnly === true;
  const ownerCaddyId = hasOwner
    ? parseOptionalOwnerCaddyId(body.ownerCaddyId)
    : current.ownerCaddyId ?? null;
  if (hasDorm && hasOwner) {
    assertCartOwnerDormitoryXor({ dormitoryOnly, ownerCaddyId });
  } else if (hasDorm && dormitoryOnly) {
    assertCartOwnerDormitoryXor({ dormitoryOnly, ownerCaddyId: null });
  } else if (hasOwner && ownerCaddyId != null) {
    assertCartOwnerDormitoryXor({ dormitoryOnly: false, ownerCaddyId });
  } else {
    assertCartOwnerDormitoryXor({ dormitoryOnly, ownerCaddyId });
  }

  const nextDorm = hasDorm && dormitoryOnly ? true : hasOwner && ownerCaddyId != null ? false : dormitoryOnly;
  const nextOwner = nextDorm ? null : ownerCaddyId;

  return {
    number: Object.prototype.hasOwnProperty.call(body, "number")
      ? normalizeCartNumber(body.number)
      : current.number,
    kind: Object.prototype.hasOwnProperty.call(body, "kind")
      ? parseCartKind(body.kind)
      : parseCartKind(current.kind),
    kindLabel: Object.prototype.hasOwnProperty.call(body, "kindLabel")
      ? normalizeOptionalText(body.kindLabel, "종류 설명")
      : current.kindLabel ?? null,
    ownerCaddyId: nextOwner,
    dormitoryOnly: nextDorm,
    operationalStatus: Object.prototype.hasOwnProperty.call(
      body,
      "operationalStatus"
    )
      ? parseCartOperationalStatus(body.operationalStatus)
      : parseCartOperationalStatus(current.operationalStatus),
    note: Object.prototype.hasOwnProperty.call(body, "note")
      ? normalizeOptionalText(body.note, "메모")
      : current.note ?? null,
  };
}

export function isCartNumberUniqueViolation(error: {
  code?: string;
  meta?: { target?: unknown };
}): boolean {
  if (error.code !== "P2002") return false;
  const target = error.meta?.target;
  const fields = Array.isArray(target) ? target.map(String) : [String(target ?? "")];
  return fields.some((f) => f === "number" || f.includes("number"));
}

export function isCartOwnerUniqueViolation(error: {
  code?: string;
  meta?: { target?: unknown };
}): boolean {
  if (error.code !== "P2002") return false;
  const target = error.meta?.target;
  const fields = Array.isArray(target) ? target.map(String) : [String(target ?? "")];
  return fields.some(
    (f) => f === "ownerCaddyId" || f.includes("ownerCaddyId")
  );
}
