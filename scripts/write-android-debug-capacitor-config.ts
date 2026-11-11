/**
 * Writes Debug-only Capacitor overlay so assembleDebug can load a Preview origin.
 * Never touches src/main (Release / cap sync production URL).
 *
 * 실행: npm run native:android-debug-preview-config -- --url https://...
 */
import fs from "node:fs";
import path from "node:path";
import {
  ANDROID_DEBUG_PREVIEW_DEFAULT_URL,
  ANDROID_DEBUG_PREVIEW_PRODUCTION_HOSTS,
  androidDebugPreviewHostFromUrl,
} from "../src/lib/androidDebugPreviewHost";

function argValue(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  if (idx < 0 || idx + 1 >= process.argv.length) return null;
  return process.argv[idx + 1];
}

function main() {
  const raw =
    argValue("--url") ||
    process.env.VERTHILL_DEBUG_SERVER_URL ||
    ANDROID_DEBUG_PREVIEW_DEFAULT_URL;
  const host = androidDebugPreviewHostFromUrl(raw);
  if (!host) {
    console.error("invalid debug Preview URL");
    process.exit(1);
  }
  const origin = `https://${host}`;
  const config = {
    appId: "kr.verthill.caddy",
    appName: "VERTHILL",
    webDir: "native/www",
    android: { allowMixedContent: false },
    plugins: {
      PushNotifications: { presentationOptions: ["badge", "sound", "alert"] },
    },
    server: {
      url: origin,
      cleartext: false,
      androidScheme: "https",
      allowNavigation: [...ANDROID_DEBUG_PREVIEW_PRODUCTION_HOSTS, host],
    },
  };
  const outDir = path.resolve("android/app/src/debug/assets");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, "capacitor.config.json");
  fs.writeFileSync(outFile, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`debug capacitor overlay: ${host}`);
}

main();
