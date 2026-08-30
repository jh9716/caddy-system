/** Block silent loss of in-flight pipeline mutations on refresh / leave. */

export const PIPELINE_UNLOAD_MESSAGE =
  "변경사항 저장 중입니다. 페이지를 나가면 병가 등 변경이 반영되지 않을 수 있습니다.";

export const PIPELINE_UNLOAD_TOAST =
  "변경사항 저장 중입니다. 저장이 끝날 때까지 페이지를 나가지 마세요.";

export const PIPELINE_UNLOAD_HINT =
  "새로고침하면 반영되지 않을 수 있습니다";

export const PIPELINE_DIRTY_RELOAD_TOAST =
  "저장 완료 전 페이지를 벗어나 일부 병가/이동이 반영되지 않았을 수 있습니다. 보드를 확인하세요.";

export const PIPELINE_DIRTY_STORAGE_KEY = "caddy.pipeline.unsaved";

export function pipelineHasUnsavedWork(input: {
  pendingIntentCount: number;
  persistInFlight: boolean;
}): boolean {
  return Boolean(input.persistInFlight) || Number(input.pendingIntentCount) > 0;
}

export function shouldBlockAnchorNavigation(input: {
  href: string | null | undefined;
  target?: string | null;
  button?: number;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}): boolean {
  if (!input.href) return false;
  if (input.button != null && input.button !== 0) return false;
  if (input.metaKey || input.ctrlKey || input.shiftKey || input.altKey) {
    return false;
  }
  const target = String(input.target || "");
  if (target === "_blank") return false;
  if (
    input.href.startsWith("#") ||
    input.href.startsWith("javascript:") ||
    input.href.startsWith("mailto:")
  ) {
    return false;
  }
  return true;
}

export function markPipelineDirty(
  storage: Pick<Storage, "setItem">,
  meta: { date: string; count: number }
) {
  storage.setItem(
    PIPELINE_DIRTY_STORAGE_KEY,
    JSON.stringify({ date: meta.date, count: meta.count, t: Date.now() })
  );
}

export function clearPipelineDirty(storage: Pick<Storage, "removeItem">) {
  storage.removeItem(PIPELINE_DIRTY_STORAGE_KEY);
}

export function consumePipelineDirty(
  storage: Pick<Storage, "getItem" | "removeItem">
): { date: string; count: number } | null {
  const raw = storage.getItem(PIPELINE_DIRTY_STORAGE_KEY);
  storage.removeItem(PIPELINE_DIRTY_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { date?: unknown; count?: unknown };
    if (!parsed || typeof parsed.date !== "string") return null;
    return { date: parsed.date, count: Number(parsed.count) || 0 };
  } catch {
    return null;
  }
}
