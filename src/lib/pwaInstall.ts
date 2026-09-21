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

export const PWA_INSTALL_TITLE = "홈 화면에 추가";
export const PWA_INSTALL_BUTTON = "설치";
export const PWA_INSTALL_STANDALONE_LABEL = "앱으로 사용 중";
export const PWA_INSTALL_LEAD =
  "앱처럼 설치하면 홈 화면에서 바로 열고 알림을 받을 수 있습니다.";
export const PWA_INSTALL_ANDROID_BODY =
  "설치를 누르면 홈 화면에 추가됩니다. 앱처럼 열고 알림을 받을 수 있습니다.";
export const PWA_INSTALL_ANDROID_HINT_BODY =
  "브라우저 메뉴에서 홈 화면에 추가 또는 설치를 선택하세요.";
export const PWA_INSTALL_SAMSUNG_BODY =
  "삼성 인터넷 메뉴에서 홈 화면에 추가를 선택하세요. 앱처럼 열고 알림을 받을 수 있습니다.";
export const PWA_INSTALL_IOS_BODY =
  "Safari 공유 버튼 → 홈 화면에 추가를 선택하세요.";

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
