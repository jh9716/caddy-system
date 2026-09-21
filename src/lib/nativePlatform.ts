/**
 * Official Capacitor native detection. No User-Agent sniffing.
 * Server and unit tests pass { isNativePlatform } explicitly.
 */
export function isCapacitorNativePlatform(input: {
  isNativePlatform: boolean;
}): boolean {
  return input.isNativePlatform === true;
}

export function shouldHidePwaInstallUi(input: {
  isNativePlatform: boolean;
}): boolean {
  return isCapacitorNativePlatform(input);
}

export function shouldUseNativePushUi(input: {
  isNativePlatform: boolean;
}): boolean {
  return isCapacitorNativePlatform(input);
}
