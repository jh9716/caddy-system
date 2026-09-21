/**
 * Compute Kakao Developers Android DEBUG KEY HASH from this PoC's debug cert.
 *
 * Kakao key hash = Base64(SHA-1(signing certificate)).
 * Uses android/app/debug.keystore (same cert as the sideloaded debug APK).
 *
 *   npx tsx scripts/compute-android-kakao-debug-key-hash.ts
 *
 * Never prints private keys. Release/Play signing hash is out of scope.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Locked to android/app/debug.keystore / current debug APK signer. */
export const EXPECTED_DEBUG_KAKAO_KEY_HASH = "M9h5pMYFj0yFLApYg+RqeR/8sdI=";
export const DEBUG_KEYSTORE_REL = "android/app/debug.keystore";
export const DEBUG_KEY_ALIAS = "androiddebugkey";
export const DEBUG_STORE_PASS = "android";

function keystorePath(): string {
  return path.resolve(DEBUG_KEYSTORE_REL);
}

export function kakaoKeyHashFromCertDer(der: Buffer): string {
  const sha1 = createHash("sha1").update(der).digest();
  return sha1.toString("base64");
}

export function exportDebugCertDer(storeFile = keystorePath()): Buffer {
  if (!fs.existsSync(storeFile)) {
    throw new Error(`missing debug keystore: ${storeFile}`);
  }
  const der = execFileSync(
    "keytool",
    [
      "-exportcert",
      "-alias",
      DEBUG_KEY_ALIAS,
      "-keystore",
      storeFile,
      "-storepass",
      DEBUG_STORE_PASS,
      "-keypass",
      DEBUG_STORE_PASS,
    ],
    { encoding: "buffer" }
  );
  return Buffer.from(der);
}

export function computeDebugKakaoKeyHash(storeFile = keystorePath()): string {
  return kakaoKeyHashFromCertDer(exportDebugCertDer(storeFile));
}

function main() {
  const hash = computeDebugKakaoKeyHash();
  console.log("package=kr.verthill.caddy");
  console.log(`keystore=${DEBUG_KEYSTORE_REL}`);
  console.log(`kakao_debug_key_hash=${hash}`);
  if (hash !== EXPECTED_DEBUG_KAKAO_KEY_HASH) {
    console.error(
      `hash drift vs locked ${EXPECTED_DEBUG_KAKAO_KEY_HASH}`
    );
    process.exit(1);
  }
  console.log("release_key_hash=NOT_AVAILABLE");
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith(
  "compute-android-kakao-debug-key-hash.ts"
)) {
  main();
}
