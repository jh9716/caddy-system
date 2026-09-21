/**
 * PWA Install V1 helpers.
 * Does not request notification permission or store push endpoints.
 */

export type PwaInstallSurface =
  | "hidden"
  | "standalone"
  | "android-prompt"
  | "android-hint"
  | "samsung-hint"
  | "ios-hint";

export function isStandaloneDisplay(input: {
  displayModeStandalone: boolean;
  iosNavigatorStandalone: boolean;
}): boolean {
  return input.displayModeStandalone || input.iosNavigatorStandalone;
}

export function isIosDevice(userAgent: string): boolean {
  return /iPhone|iPad|iPod/i.test(userAgent);
}

export function isSamsungInternet(userAgent: string): boolean {
  return /SamsungBrowser/i.test(userAgent);
}

export function isAndroidDevice(userAgent: string): boolean {
  return /Android/i.test(userAgent) && !isIosDevice(userAgent);
}

export function shouldRegisterServiceWorker(input: {
  hasServiceWorker: boolean;
  isSecureContext: boolean;
}): boolean {
  return input.hasServiceWorker && input.isSecureContext;
}

/**
 * Install card rules:
 * - standalone (home-screen PWA) → compact "in use" state, no install CTA
 * - iOS Safari / Chrome iOS (no beforeinstallprompt) → share → Add to Home Screen
 * - Chromium after beforeinstallprompt → install button
 * - Samsung Internet without BIP → menu → 홈 화면에 추가
 * - other Android without BIP → menu → 설치 / 홈 화면에 추가
 * - desktop without BIP → hide (do not nag)
 */
export function resolvePwaInstallSurface(input: {
  standalone: boolean;
  ios: boolean;
  hasBeforeInstallPrompt: boolean;
  samsung?: boolean;
  android?: boolean;
}): PwaInstallSurface {
  if (input.standalone) return "standalone";
  if (input.ios) return "ios-hint";
  if (input.hasBeforeInstallPrompt) return "android-prompt";
  if (input.samsung) return "samsung-hint";
  if (input.android) return "android-hint";
  return "hidden";
}

export type PwaInstallAction = "prompt" | "sheet" | "hide";

export function isPwaInstalled(input: {
  standalone: boolean;
  appInstalled: boolean;
}): boolean {
  return input.standalone || input.appInstalled;
}

export function resolvePwaInstallAction(
  surface: PwaInstallSurface
): PwaInstallAction {
  if (surface === "android-prompt") return "prompt";
  if (
    surface === "samsung-hint" ||
    surface === "ios-hint" ||
    surface === "android-hint"
  ) {
    return "sheet";
  }
  return "hide";
}

export function shouldShowHomeInstallCta(input: {
  surface: PwaInstallSurface;
  installed: boolean;
}): boolean {
  if (input.installed || input.surface === "standalone") return false;
  return resolvePwaInstallAction(input.surface) !== "hide";
}

export const PWA_INSTALL_TITLE = "홈 화면에 추가";
export const PWA_INSTALL_CTA_LABEL = "VERTHILL 앱 설치";
export const PWA_INSTALL_BUTTON = "설치";
export const PWA_INSTALL_STANDALONE_LABEL = "앱으로 사용 중";
export const PWA_INSTALL_LEAD =
  "앱처럼 설치하면 홈 화면에서 바로 열고 알림을 받을 수 있습니다.";
export const PWA_INSTALL_ANDROID_BODY =
  "설치를 누르면 홈 화면에 추가됩니다. 앱처럼 열고 알림을 받을 수 있습니다.";
export const PWA_INSTALL_ANDROID_HINT_BODY =
  "브라우저 메뉴에서 홈 화면에 추가 또는 설치를 선택하세요.";
export const PWA_INSTALL_SAMSUNG_BODY =
  "삼성 인터넷 메뉴(⋮)에서 '현재 페이지 추가' 또는 '홈 화면에 추가'를 선택하세요.";
export const PWA_INSTALL_IOS_BODY = "공유 버튼 → 홈 화면에 추가";
export const PWA_INSTALL_SHEET_CLOSE = "닫기";

export const PWA_INSTALL_IOS_STEPS = [
  "화면 아래 공유 버튼을 탭합니다.",
  "'홈 화면에 추가'를 선택합니다.",
  "추가를 눌러 홈 화면에 둡니다.",
] as const;

export const PWA_INSTALL_SAMSUNG_STEPS = [
  "오른쪽 위 메뉴(점 3개)를 엽니다.",
  "'현재 페이지 추가' 또는 '홈 화면에 추가'를 선택합니다.",
  "홈 화면에서 VERTHILL을 앱처럼 엽니다.",
] as const;

export const PWA_INSTALL_ANDROID_STEPS = [
  "브라우저 메뉴를 엽니다.",
  "홈 화면에 추가 또는 설치를 선택합니다.",
  "홈 화면에서 VERTHILL을 앱처럼 엽니다.",
] as const;

export function pwaInstallBody(surface: PwaInstallSurface): string {
  switch (surface) {
    case "ios-hint":
      return PWA_INSTALL_IOS_BODY;
    case "samsung-hint":
      return PWA_INSTALL_SAMSUNG_BODY;
    case "android-hint":
      return PWA_INSTALL_ANDROID_HINT_BODY;
    case "android-prompt":
      return PWA_INSTALL_ANDROID_BODY;
    default:
      return PWA_INSTALL_LEAD;
  }
}

export function pwaInstallHintSteps(
  surface: PwaInstallSurface
): readonly string[] {
  switch (surface) {
    case "ios-hint":
      return PWA_INSTALL_IOS_STEPS;
    case "samsung-hint":
      return PWA_INSTALL_SAMSUNG_STEPS;
    case "android-hint":
      return PWA_INSTALL_ANDROID_STEPS;
    default:
      return [];
  }
}
