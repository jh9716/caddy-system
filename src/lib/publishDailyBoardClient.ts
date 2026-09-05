import type { DrainDraftSavesResult, DraftFlushStatus } from "@/lib/draftSaveFlush";
import {
  PUBLISH_STALE_DRAFT,
  PUBLISH_STALE_DRAFT_MESSAGE,
  PUBLISH_SUCCESS_MESSAGE,
} from "@/lib/dailyBoardPublished";

export const PUBLISH_BUSY_LABEL = "확정 중...";
export const PUBLISH_ACTION_LABEL = "배치 확정";
export const PUBLISH_AGAIN_LABEL = "변경사항 다시 확정";
export const PUBLISH_CURRENT_LABEL = "현재 배치 확정됨";
export const PUBLISH_HINT = "확정하면 캐디 공용 배치표에 게시됩니다.";

export function publishBoardActionState(input: {
  publishing: boolean;
  hasDraft: boolean;
  published: { sourceDraftVersion: number } | null;
  draftVersion: number;
  conflict?: boolean;
  blocked?: boolean;
}): { label: string; disabled: boolean; alreadyCurrent: boolean } {
  if (input.publishing) {
    return { label: PUBLISH_BUSY_LABEL, disabled: true, alreadyCurrent: false };
  }
  const alreadyCurrent = Boolean(
    input.published && input.published.sourceDraftVersion === input.draftVersion
  );
  const disabled =
    !input.hasDraft ||
    Boolean(input.conflict) ||
    Boolean(input.blocked) ||
    alreadyCurrent;
  if (alreadyCurrent) {
    return { label: PUBLISH_CURRENT_LABEL, disabled, alreadyCurrent: true };
  }
  if (input.published) {
    return { label: PUBLISH_AGAIN_LABEL, disabled, alreadyCurrent: false };
  }
  return { label: PUBLISH_ACTION_LABEL, disabled, alreadyCurrent: false };
}

export type PublishServerTimings = {
  getDraftMs: number;
  snapshotMs: number;
  upsertMs: number;
  totalMs: number;
};

export type PublishFlowTimings = {
  drainTotalMs: number;
  pendingDebounceFlushMs: number;
  inFlightWaitMs: number;
  extraFlushMs: number;
  extraFlushRan: boolean;
  skippedSave: boolean;
  postRoundTripMs: number;
  publishedRefetchMs: number;
  uiStateUpdateMs: number;
  totalMs: number;
  server: PublishServerTimings | null;
};

export type PublishPostResult<TPublished> = {
  ok: boolean;
  status: number;
  published?: TPublished | null;
  message?: string;
  error?: string;
  code?: string;
  timings?: PublishServerTimings;
};

export type PublishFlowResult<TPublished> = {
  ok: boolean;
  duplicateClick?: boolean;
  conflict?: boolean;
  error?: string;
  message?: string;
  published?: TPublished;
  timings: PublishFlowTimings;
};

const ZERO_TIMINGS: PublishFlowTimings = {
  drainTotalMs: 0,
  pendingDebounceFlushMs: 0,
  inFlightWaitMs: 0,
  extraFlushMs: 0,
  extraFlushRan: false,
  skippedSave: true,
  postRoundTripMs: 0,
  publishedRefetchMs: 0,
  uiStateUpdateMs: 0,
  totalMs: 0,
  server: null,
};

function defaultNow(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function drainToFlow(drain: DrainDraftSavesResult["timings"]): Pick<
  PublishFlowTimings,
  | "drainTotalMs"
  | "pendingDebounceFlushMs"
  | "inFlightWaitMs"
  | "extraFlushMs"
  | "extraFlushRan"
  | "skippedSave"
> {
  return {
    drainTotalMs: drain.totalMs,
    pendingDebounceFlushMs: drain.pendingDebounceFlushMs,
    inFlightWaitMs: drain.inFlightWaitMs,
    extraFlushMs: drain.extraFlushMs,
    extraFlushRan: drain.extraFlushRan,
    skippedSave: drain.skippedSave,
  };
}

/**
 * Publish click handler: mark busy immediately, drain pending Draft (no debounce wait),
 * POST once, apply the POST body to local state. No extra Published GET.
 */
export async function runPublishBoardFlow<TPublished>(input: {
  isBusy: () => boolean;
  setBusy: (busy: boolean) => void;
  drain: () => Promise<{ status: DraftFlushStatus; timings: DrainDraftSavesResult["timings"] }>;
  getDraftVersion: () => number;
  publish: (draftVersion: number) => Promise<PublishPostResult<TPublished>>;
  applyPublished: (published: TPublished) => void;
  now?: () => number;
}): Promise<PublishFlowResult<TPublished>> {
  const now = input.now ?? defaultNow;
  if (input.isBusy()) {
    return { ok: false, duplicateClick: true, timings: { ...ZERO_TIMINGS } };
  }

  input.setBusy(true);
  const t0 = now();
  const timings: PublishFlowTimings = { ...ZERO_TIMINGS };

  try {
    const drainResult = await input.drain();
    Object.assign(timings, drainToFlow(drainResult.timings));

    if (drainResult.status === "conflict") {
      return {
        ok: false,
        conflict: true,
        error: PUBLISH_STALE_DRAFT_MESSAGE,
        timings: { ...timings, totalMs: now() - t0 },
      };
    }
    if (drainResult.status === "error") {
      return {
        ok: false,
        error: "작업본 저장에 실패했습니다. 다시 확정해 주세요.",
        timings: { ...timings, totalMs: now() - t0 },
      };
    }

    const version = input.getDraftVersion();
    if (!version) {
      return {
        ok: false,
        error: "작업본이 아직 저장되지 않았습니다. 잠시 후 다시 확정해 주세요.",
        timings: { ...timings, totalMs: now() - t0 },
      };
    }

    const tPost0 = now();
    const data = await input.publish(version);
    timings.postRoundTripMs = now() - tPost0;
    timings.server = data.timings ?? null;
    timings.publishedRefetchMs = 0;

    if (data.status === 409 || data.code === PUBLISH_STALE_DRAFT) {
      return {
        ok: false,
        conflict: true,
        error: data.message || PUBLISH_STALE_DRAFT_MESSAGE,
        timings: { ...timings, totalMs: now() - t0 },
      };
    }
    if (!data.ok || !data.published) {
      return {
        ok: false,
        error: data.message || data.error || "배치 확정 실패",
        timings: { ...timings, totalMs: now() - t0 },
      };
    }

    const tUi0 = now();
    input.applyPublished(data.published);
    timings.uiStateUpdateMs = now() - tUi0;
    timings.totalMs = now() - t0;

    return {
      ok: true,
      message: data.message || PUBLISH_SUCCESS_MESSAGE,
      published: data.published,
      timings,
    };
  } catch (e: unknown) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "배치 확정 실패",
      timings: { ...timings, totalMs: now() - t0 },
    };
  } finally {
    input.setBusy(false);
  }
}
