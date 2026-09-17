/**
 * PWA Install V1 helpers.
 * Does not request notification permission or store push endpoints.
 */

export type PwaInstallSurface =
  | "hidden"
  | "standalone"
  | "android-prompt"
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

export function shouldRegisterServiceWorker(input: {
  hasServiceWorker: boolean;
  isSecureContext: boolean;
}): boolean {
  return input.hasServiceWorker && input.isSecureContext;
}

/**
 * Install card rules:
 * - standalone (home-screen PWA) → compact "in use" state, no install CTA
 * - iOS Safari (no beforeinstallprompt) → share → Add to Home Screen hint
 * - Chromium after beforeinstallprompt → install button only
 * - otherwise hide (do not nag)
 */
export function resolvePwaInstallSurface(input: {
  standalone: boolean;
  ios: boolean;
  hasBeforeInstallPrompt: boolean;
}): PwaInstallSurface {
  if (input.standalone) return "standalone";
  if (input.ios) return "ios-hint";
  if (input.hasBeforeInstallPrompt) return "android-prompt";
  return "hidden";
}

export const PWA_INSTALL_TITLE = "VERTHILL 앱 설치";
export const PWA_INSTALL_ANDROID_BODY = "홈 화면에서 바로 열 수 있습니다.";
export const PWA_INSTALL_BUTTON = "앱 설치";
export const PWA_INSTALL_IOS_BODY =
  "아이폰에서는 공유 버튼 → 홈 화면에 추가";
export const PWA_INSTALL_STANDALONE_LABEL = "앱으로 사용 중";
