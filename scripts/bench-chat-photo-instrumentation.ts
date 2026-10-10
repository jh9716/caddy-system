/**
 * Local instrumentation overhead: photoDebug on vs off.
 * Fake compress (no bitmap/JPEG/offscreen). Does not touch Production.
 * 실행: npx tsx scripts/bench-chat-photo-instrumentation.ts
 */
import {
  enableChatPhotoDebugTiming,
  resetChatPhotoTiming,
  startChatPhotoPrepareTiming,
} from "../src/lib/chatPhotoTiming";
import { prepareChatPhotoSource } from "../src/lib/chatPhotoFastPath";

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

async function runOnce(debug: boolean): Promise<number> {
  resetChatPhotoTiming();
  enableChatPhotoDebugTiming(debug);
  const file = new File([new Uint8Array(2.2 * 1024 * 1024)], "bench.jpg", { type: "image/jpeg" });
  if (debug) startChatPhotoPrepareTiming("cph-1", file);
  const started = performance.now();
  await prepareChatPhotoSource(file, async (next) => next);
  return performance.now() - started;
}

async function bench(label: string, debug: boolean, rounds: number) {
  enableChatPhotoDebugTiming(debug);
  for (let i = 0; i < 5; i++) await runOnce(debug);
  const samples: number[] = [];
  for (let i = 0; i < rounds; i++) samples.push(await runOnce(debug));
  return {
    label,
    debug,
    rounds,
    minMs: Number(Math.min(...samples).toFixed(3)),
    medianMs: Number(median(samples).toFixed(3)),
    meanMs: Number(mean(samples).toFixed(3)),
    maxMs: Number(Math.max(...samples).toFixed(3)),
  };
}

async function main() {
  const rounds = 40;
  const off = await bench("photoDebug-off", false, rounds);
  const on = await bench("photoDebug-on", true, rounds);
  const result = {
    note: "Fake compress only. Measures Proxy + prepare-scope + source-split bookkeeping, not bitmap/JPEG.",
    off,
    on,
    medianDeltaMs: Number((on.medianMs - off.medianMs).toFixed(3)),
  };
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
