/**
 * Caddy 차량번호 정규화.
 * 별도 필드(Caddy.vehicleNumber). null=미등록. 관리자 전용.
 * 콘솔에 원문을 출력하지 말 것.
 */

export const VEHICLE_NUMBER_MAX_LEN = 20;

export class CaddyVehicleError extends Error {
  constructor(
    message: string,
    public status: number = 400,
    public code: string = "invalid_vehicle"
  ) {
    super(message);
    this.name = "CaddyVehicleError";
  }
}

/** 빈 입력 → null. 유효 → trim 문자열. 무효 → throw CaddyVehicleError */
export function parseOptionalVehicleInput(input: unknown): string | null {
  if (input === undefined || input === null) return null;
  const raw = String(input)
    .replace(/\u00a0/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  if (raw === "") return null;
  if (raw.length > VEHICLE_NUMBER_MAX_LEN) {
    throw new CaddyVehicleError(
      `차량번호는 ${VEHICLE_NUMBER_MAX_LEN}자 이하여야 합니다.`
    );
  }
  if (!/^[\p{L}\p{N}\s\-]+$/u.test(raw)) {
    throw new CaddyVehicleError(
      "유효한 차량번호가 아닙니다. 예: 12가3456"
    );
  }
  return raw;
}

/** 관리자 표시용. null/빈값 → null. */
export function formatVehicleDisplay(
  vehicleNumber: string | null | undefined
): string | null {
  if (vehicleNumber == null) return null;
  const v = String(vehicleNumber).trim();
  return v === "" ? null : v;
}

/** 감사 로그용. 원문 차량번호를 남기지 않는다. */
export function auditVehicleNumber(
  vehicleNumber: string | null | undefined
): "set" | null {
  return formatVehicleDisplay(vehicleNumber) ? "set" : null;
}
