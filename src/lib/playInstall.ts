/**
 * Google Play closed-test install copy and URL helpers.
 * The Play tester URL is read from NEXT_PUBLIC_GOOGLE_PLAY_TEST_URL only.
 */

export const GOOGLE_PLAY_TEST_URL_ENV = "NEXT_PUBLIC_GOOGLE_PLAY_TEST_URL";

export const PLAY_INSTALL_TITLE = "VERTHILL 앱 설치";
export const PLAY_INSTALL_CTA_LABEL = "Google Play에서 설치";
export const PLAY_INSTALL_WEBAPP_LABEL = "웹앱으로 사용하기";
export const PLAY_INSTALL_CLOSE = "닫기";
export const PLAY_INSTALL_MISSING_URL =
  "Google Play 테스트 설치 링크가 아직 설정되지 않았습니다. 관리자에게 문의해주세요.";

export const PLAY_INSTALL_STEPS = [
  "Google Play 비공개 테스트에 등록된 Google 계정으로 로그인합니다.",
  "아래 ‘Google Play에서 설치’ 버튼을 누릅니다.",
  "테스트 참여 화면이 나오면 참여한 뒤 Play 스토어에서 VERTHILL을 설치합니다.",
] as const;

export function readGooglePlayTestUrl(
  raw: string | undefined | null
): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return trimmed;
  } catch {
    return null;
  }
}

export function googlePlayTestUrlFromEnv(
  raw: string | undefined | null = process.env.NEXT_PUBLIC_GOOGLE_PLAY_TEST_URL
): string | null {
  return readGooglePlayTestUrl(raw);
}

export function shouldOfferWebAppInstall(action: "prompt" | "sheet" | "hide"): boolean {
  return action === "prompt" || action === "sheet";
}

export type HomeInstallPrimary = "play" | "pwa-sheet" | "hide";

/**
 * Home `VERTHILL 앱 설치` click:
 * - Android web → Play closed-test modal
 * - iOS web → existing PWA add-to-home-screen sheet
 * - native / standalone / desktop → hide (button already hidden)
 */
export function resolveHomeInstallPrimary(
  surface:
    | "hidden"
    | "standalone"
    | "android-prompt"
    | "android-hint"
    | "samsung-hint"
    | "ios-hint"
): HomeInstallPrimary {
  if (surface === "ios-hint") return "pwa-sheet";
  if (
    surface === "android-prompt" ||
    surface === "android-hint" ||
    surface === "samsung-hint"
  ) {
    return "play";
  }
  return "hide";
}
