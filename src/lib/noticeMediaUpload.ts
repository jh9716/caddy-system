export const NOTICE_MEDIA_UPLOAD_CONCURRENCY = 3;

export type NoticeUploadProgress = {
  done: number;
  total: number;
};

export type NoticeUploadOptions = {
  post?: typeof fetch;
  onProgress?: (progress: NoticeUploadProgress) => void;
  sortOrderStart?: number;
};

export function resolveNoticeUploadOptions(
  postOrOpts?: typeof fetch | NoticeUploadOptions,
  onProgress?: (progress: NoticeUploadProgress) => void
): {
  post: typeof fetch;
  onProgress?: (progress: NoticeUploadProgress) => void;
  sortOrderStart?: number;
} {
  if (typeof postOrOpts === "function") {
    return { post: postOrOpts, onProgress };
  }
  return {
    post: postOrOpts?.post ?? fetch,
    onProgress: postOrOpts?.onProgress ?? onProgress,
    sortOrderStart: postOrOpts?.sortOrderStart,
  };
}

export async function mapNoticeBoundedSettled<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const workers = Math.max(1, Math.min(limit, items.length || 1));
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = { status: "fulfilled", value: await fn(items[index], index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(workers, Math.max(items.length, 1)) }, () => worker())
  );
  return results;
}
