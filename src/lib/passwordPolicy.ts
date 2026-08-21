export const MIN_NEW_PASSWORD_LENGTH = 8;

export const BANNED_TEMP_NUMERIC_PASSWORDS = new Set([
  "12345678",
  "87654321",
  "01234567",
  "76543210",
]);

export type NewPasswordIssue =
  | "too_short"
  | "same_as_current"
  | "confirm_mismatch";

export function isEightDigitNumeric(value: string): boolean {
  return /^\d{8}$/.test(value);
}

/** Predictable 8-digit temps that must never be issued. */
export function isBannedTempNumericPassword(value: string): boolean {
  if (!isEightDigitNumeric(value)) return true;
  if (BANNED_TEMP_NUMERIC_PASSWORDS.has(value)) return true;
  if (/^(\d)\1{7}$/.test(value)) return true;
  if ("0123456789".includes(value) || "9876543210".includes(value)) return true;
  return false;
}

export function validateNewPassword(
  newPassword: string,
  currentPassword: string
): NewPasswordIssue | null {
  const next = String(newPassword ?? "");
  const current = String(currentPassword ?? "");
  if (next.length < MIN_NEW_PASSWORD_LENGTH) return "too_short";
  if (next === current) return "same_as_current";
  return null;
}

export function validatePasswordConfirm(
  newPassword: string,
  confirmPassword: string
): NewPasswordIssue | null {
  if (String(newPassword ?? "") !== String(confirmPassword ?? "")) {
    return "confirm_mismatch";
  }
  return null;
}

export function newPasswordIssueMessage(issue: NewPasswordIssue): string {
  switch (issue) {
    case "too_short":
      return `새 비밀번호는 ${MIN_NEW_PASSWORD_LENGTH}자 이상이어야 합니다.`;
    case "same_as_current":
      return "새 비밀번호는 현재 비밀번호와 달라야 합니다.";
    case "confirm_mismatch":
      return "새 비밀번호 확인이 일치하지 않습니다.";
  }
}

export function shouldForcePasswordChange(auth: {
  userId: number | null;
  mustChangePassword: boolean;
} | null): boolean {
  return !!auth && auth.userId != null && auth.mustChangePassword === true;
}

export function postLoginPath(
  role: string,
  mustChangePassword: boolean
): string {
  if (mustChangePassword) return "/change-password";
  if (role === "admin") return "/manage";
  return "/caddy";
}
