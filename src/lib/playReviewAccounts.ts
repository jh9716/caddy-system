/**
 * Google Play review account create/disable planning.
 * Passwords are never logged. Writes happen only when the caller applies
 * a confirmed plan. username=admin and real staff users are never targets.
 */
import { DRIVING_POOL_TEAM } from "@/lib/caddyManage";
import { SUPER_ADMIN_USERNAME } from "@/lib/staffAdminAccounts";

export const PLAY_REVIEW_ADMIN_USERNAME = "playreview_admin";
export const PLAY_REVIEW_CADDY_USERNAME = "playreview_caddy";
export const PLAY_REVIEW_CADDY_NAME = "Google Play Review";
export const PLAY_REVIEW_CADDY_MEMO = "GOOGLE_PLAY_REVIEW_ONLY";
export const PLAY_REVIEW_CREATE_CONFIRM = "CREATE_PLAY_REVIEW_ACCOUNTS";
export const PLAY_REVIEW_DISABLE_CONFIRM = "DISABLE_PLAY_REVIEW_ACCOUNTS";
export const PLAY_REVIEW_ADMIN_PASSWORD_ENV = "PLAY_REVIEW_ADMIN_PASSWORD";
export const PLAY_REVIEW_CADDY_PASSWORD_ENV = "PLAY_REVIEW_CADDY_PASSWORD";

export const PLAY_REVIEW_USERNAMES = [
  PLAY_REVIEW_ADMIN_USERNAME,
  PLAY_REVIEW_CADDY_USERNAME,
] as const;

export const FORBIDDEN_USER_WRITE_USERNAMES = [SUPER_ADMIN_USERNAME] as const;

export type PlayReviewMode = "create" | "disable";

export type PlayReviewCliArgs = {
  apply: boolean;
  disable: boolean;
  confirm: string | null;
};

export type InspectedReviewUser = {
  id: number;
  username: string;
  role: string;
  kakaoUserId: string | null;
  caddyId: number | null;
  mustChangePassword: boolean;
  managedTeams: string[];
  passwordPresent: boolean;
};

export type InspectedReviewCaddy = {
  id: number;
  name: string;
  caddyType: string;
  team: string;
  teamOrder: number;
  employmentStatus: string;
  phoneNormalized: string | null;
  memo: string | null;
  linkedUserId: number | null;
};

export type PlayReviewSnapshot = {
  admin: InspectedReviewUser | null;
  caddyUser: InspectedReviewUser | null;
  reviewCaddies: InspectedReviewCaddy[];
};

export type PlayReviewPlan =
  | { action: "create"; writes: true }
  | { action: "already_created"; writes: false }
  | { action: "disable"; writes: true; userIds: number[]; caddyId: number | null }
  | { action: "already_disabled"; writes: false }
  | { action: "fail"; writes: false; errors: string[] };

export function parsePlayReviewArgs(argv: string[]): PlayReviewCliArgs {
  let apply = false;
  let disable = false;
  let confirm: string | null = null;
  for (const raw of argv) {
    if (raw === "--apply") apply = true;
    else if (raw === "--disable") disable = true;
    else if (raw.startsWith("--confirm=")) {
      confirm = raw.slice("--confirm=".length).trim() || null;
    }
  }
  return { apply, disable, confirm };
}

export function requiredConfirmForMode(mode: PlayReviewMode): string {
  return mode === "disable"
    ? PLAY_REVIEW_DISABLE_CONFIRM
    : PLAY_REVIEW_CREATE_CONFIRM;
}

export function canWritePlayReview(input: {
  apply: boolean;
  confirm: string | null;
  mode: PlayReviewMode;
  isProduction: boolean;
  prodMaintenanceConfirm: string | null;
}): { ok: true } | { ok: false; reason: string } {
  if (!input.apply) {
    return { ok: false, reason: "dry-run: --apply 없음" };
  }
  const expected = requiredConfirmForMode(input.mode);
  if (input.confirm !== expected) {
    return {
      ok: false,
      reason: `--confirm=${expected} 가 필요합니다`,
    };
  }
  if (input.isProduction && input.prodMaintenanceConfirm !== expected) {
    return {
      ok: false,
      reason: `production은 PROD_MAINTENANCE_CONFIRM=${expected} 가 필요합니다`,
    };
  }
  return { ok: true };
}

export function readPlayReviewPassword(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  name: typeof PLAY_REVIEW_ADMIN_PASSWORD_ENV | typeof PLAY_REVIEW_CADDY_PASSWORD_ENV
): string {
  const value = String(env[name] ?? "");
  if (!value) {
    throw new Error(`${name} 이 없습니다. 비밀번호는 환경변수로만 받습니다.`);
  }
  return value;
}

export function isForbiddenUserWrite(username: string): boolean {
  return FORBIDDEN_USER_WRITE_USERNAMES.includes(
    String(username ?? "").trim() as (typeof FORBIDDEN_USER_WRITE_USERNAMES)[number]
  );
}

export function isPlayReviewUsername(username: string): boolean {
  return (PLAY_REVIEW_USERNAMES as readonly string[]).includes(
    String(username ?? "").trim()
  );
}

export function emptyManagedTeams(value: string[] | null | undefined): boolean {
  return !Array.isArray(value) || value.length === 0;
}

export function isExpectedActiveAdmin(user: InspectedReviewUser): boolean {
  return (
    user.username === PLAY_REVIEW_ADMIN_USERNAME &&
    user.role === "admin" &&
    user.kakaoUserId == null &&
    user.caddyId == null &&
    user.mustChangePassword === false &&
    emptyManagedTeams(user.managedTeams) &&
    user.passwordPresent === true
  );
}

export function isExpectedActiveCaddyUser(
  user: InspectedReviewUser,
  reviewCaddyId: number
): boolean {
  return (
    user.username === PLAY_REVIEW_CADDY_USERNAME &&
    user.role === "caddy" &&
    user.kakaoUserId == null &&
    user.caddyId === reviewCaddyId &&
    user.mustChangePassword === false &&
    emptyManagedTeams(user.managedTeams) &&
    user.passwordPresent === true
  );
}

export function isExpectedActiveReviewCaddy(caddy: InspectedReviewCaddy): boolean {
  return (
    caddy.name === PLAY_REVIEW_CADDY_NAME &&
    caddy.caddyType === "DRIVING" &&
    caddy.team === DRIVING_POOL_TEAM &&
    caddy.teamOrder === 0 &&
    caddy.employmentStatus === "LEAVE" &&
    caddy.phoneNormalized == null &&
    caddy.memo === PLAY_REVIEW_CADDY_MEMO
  );
}

export function isExpectedDisabledAdmin(user: InspectedReviewUser): boolean {
  return (
    user.username === PLAY_REVIEW_ADMIN_USERNAME &&
    user.role === "admin" &&
    user.caddyId == null &&
    user.passwordPresent === false
  );
}

export function isExpectedDisabledCaddyUser(user: InspectedReviewUser): boolean {
  return (
    user.username === PLAY_REVIEW_CADDY_USERNAME &&
    user.role === "caddy" &&
    user.caddyId == null &&
    user.passwordPresent === false
  );
}

export function isExpectedDisabledReviewCaddy(caddy: InspectedReviewCaddy): boolean {
  return (
    caddy.memo === PLAY_REVIEW_CADDY_MEMO &&
    caddy.employmentStatus === "RETIRED" &&
    caddy.linkedUserId == null
  );
}

export function planPlayReviewCreate(snapshot: PlayReviewSnapshot): PlayReviewPlan {
  const errors: string[] = [];
  if (snapshot.reviewCaddies.length > 1) {
    errors.push("GOOGLE_PLAY_REVIEW_ONLY Caddy가 둘 이상입니다");
  }
  const reviewCaddy = snapshot.reviewCaddies[0] ?? null;
  const hasAny =
    snapshot.admin != null || snapshot.caddyUser != null || reviewCaddy != null;
  const hasAll =
    snapshot.admin != null && snapshot.caddyUser != null && reviewCaddy != null;

  if (!hasAny) {
    return { action: "create", writes: true };
  }

  if (hasAll && reviewCaddy) {
    if (!isExpectedActiveAdmin(snapshot.admin!)) {
      errors.push("playreview_admin 상태가 예상과 다릅니다");
    }
    if (!isExpectedActiveReviewCaddy(reviewCaddy)) {
      errors.push("review Caddy 상태가 예상과 다릅니다");
    }
    if (!isExpectedActiveCaddyUser(snapshot.caddyUser!, reviewCaddy.id)) {
      errors.push("playreview_caddy 상태가 예상과 다릅니다");
    }
    if (errors.length === 0) {
      return { action: "already_created", writes: false };
    }
  } else {
    errors.push("일부 review 계정/Caddy만 존재합니다. 자동 수정하지 않습니다");
  }

  return { action: "fail", writes: false, errors };
}

export function planPlayReviewDisable(snapshot: PlayReviewSnapshot): PlayReviewPlan {
  const errors: string[] = [];
  if (snapshot.reviewCaddies.length > 1) {
    errors.push("GOOGLE_PLAY_REVIEW_ONLY Caddy가 둘 이상입니다");
  }
  const reviewCaddy = snapshot.reviewCaddies[0] ?? null;

  if (snapshot.admin && isForbiddenUserWrite(snapshot.admin.username)) {
    errors.push("forbidden user write");
  }
  if (snapshot.caddyUser && isForbiddenUserWrite(snapshot.caddyUser.username)) {
    errors.push("forbidden user write");
  }

  if (
    snapshot.caddyUser?.caddyId != null &&
    reviewCaddy &&
    snapshot.caddyUser.caddyId !== reviewCaddy.id
  ) {
    errors.push("playreview_caddy가 review Caddy가 아닌 명부에 연결되어 있습니다");
  }
  if (
    snapshot.caddyUser?.caddyId != null &&
    !reviewCaddy
  ) {
    errors.push("playreview_caddy 연결 대상이 review Caddy가 아닙니다");
  }
  if (
    reviewCaddy?.linkedUserId != null &&
    snapshot.caddyUser &&
    reviewCaddy.linkedUserId !== snapshot.caddyUser.id
  ) {
    errors.push("review Caddy가 playreview_caddy가 아닌 User에 연결되어 있습니다");
  }

  if (errors.length > 0) {
    return { action: "fail", writes: false, errors };
  }

  const nothing =
    snapshot.admin == null && snapshot.caddyUser == null && reviewCaddy == null;
  if (nothing) {
    return { action: "already_disabled", writes: false };
  }

  const adminOk = !snapshot.admin || isExpectedDisabledAdmin(snapshot.admin);
  const caddyOk =
    !snapshot.caddyUser || isExpectedDisabledCaddyUser(snapshot.caddyUser);
  const rosterOk = !reviewCaddy || isExpectedDisabledReviewCaddy(reviewCaddy);
  if (adminOk && caddyOk && rosterOk) {
    return { action: "already_disabled", writes: false };
  }

  const userIds = [snapshot.admin?.id, snapshot.caddyUser?.id].filter(
    (id): id is number => typeof id === "number" && id > 0
  );
  return {
    action: "disable",
    writes: true,
    userIds,
    caddyId: reviewCaddy?.id ?? null,
  };
}

export function formatPlayReviewReport(snapshot: PlayReviewSnapshot): string {
  const admin = snapshot.admin;
  const caddyUser = snapshot.caddyUser;
  const reviewCaddy = snapshot.reviewCaddies[0] ?? null;
  const lines = [
    `playreview_admin exists=${admin != null} role=${admin?.role ?? "none"}`,
    `playreview_caddy exists=${caddyUser != null} role=${caddyUser?.role ?? "none"} caddyLinked=${caddyUser?.caddyId != null}`,
    `reviewCaddy type=${reviewCaddy?.caddyType ?? "none"} team=${reviewCaddy?.team ?? "none"} teamOrder=${reviewCaddy?.teamOrder ?? "none"} employmentStatus=${reviewCaddy?.employmentStatus ?? "none"}`,
  ];
  return lines.join("\n");
}

export function reportLooksSafe(text: string): boolean {
  return !/password|token|session|phone|hash|Bearer/i.test(text);
}

export function shouldApplyPlayReviewWrite(
  plan: PlayReviewPlan,
  gate: ReturnType<typeof canWritePlayReview>
): boolean {
  return plan.writes === true && gate.ok === true;
}
