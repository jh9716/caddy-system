/**
 * Server-only CourseReport photo object storage.
 * Client components must never import this module.
 * Token / OIDC values are never logged or returned in responses.
 *
 * Auth is resolved by @vercel/blob (do not pass credentials unless needed):
 * 1. Vercel OIDC default: VERCEL_OIDC_TOKEN + BLOB_STORE_ID
 * 2. Legacy/local fallback: BLOB_READ_WRITE_TOKEN
 */
import {
  COURSE_REPORT_BLOB_OIDC_TOKEN_ENV,
  COURSE_REPORT_BLOB_STORE_ID_ENV,
  COURSE_REPORT_BLOB_TOKEN_ENV,
} from "@/lib/courseReportPhotoConstants";

export class CourseReportPhotoStorageError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 503
  ) {
    super(message);
    this.name = "CourseReportPhotoStorageError";
  }
}

export type PhotoObjectBody = import("@/lib/photoObjectBody").PhotoObjectBody;

export type PhotoOpenOptions = {
  abortSignal?: AbortSignal;
};

export type PhotoSignedPutUrl = {
  uploadUrl: string;
  expiresAt: number;
};

export type PhotoSignedPutInput = {
  pathname: string;
  contentType: string;
  maximumSizeInBytes: number;
  validUntilMs: number;
};

export type PhotoObjectMeta = {
  size: number;
  contentType: string;
};

export type CourseReportPhotoStore = {
  configured: boolean;
  put(key: string, bytes: Uint8Array, mimeType: string): Promise<void>;
  get(key: string, opts?: PhotoOpenOptions): Promise<Uint8Array | null>;
  /** Official Blob stream. GET uses this so the API does not buffer the whole object first. */
  open?(key: string, opts?: PhotoOpenOptions): Promise<PhotoObjectBody | null>;
  delete(key: string): Promise<void>;
  /** Size/contentType only. Never expose store URLs or credentials. */
  head(key: string): Promise<PhotoObjectMeta | null>;
  /** First maxBytes only. Must not buffer the rest of the object. */
  readPrefix(key: string, maxBytes: number): Promise<Uint8Array | null>;
  /**
   * Exact-pathname private PUT URL. Implementations must never return store
   * credentials or clientSigningToken — only the finished presigned URL.
   */
  createSignedPutUrl?(input: PhotoSignedPutInput): Promise<PhotoSignedPutUrl>;
};

function envNonEmpty(name: string): boolean {
  const raw = process.env[name];
  return typeof raw === "string" && raw.trim().length > 0;
}

function hasLegacyBlobToken(): boolean {
  return envNonEmpty(COURSE_REPORT_BLOB_TOKEN_ENV);
}

function hasOidcBlobAuth(): boolean {
  if (!envNonEmpty(COURSE_REPORT_BLOB_STORE_ID_ENV)) return false;
  if (envNonEmpty(COURSE_REPORT_BLOB_OIDC_TOKEN_ENV)) return true;
  return process.env.VERCEL === "1";
}

export type CourseReportPhotoStorageAuthStatus = {
  ready: boolean;
  oidc: boolean;
  token: boolean;
};

export function getCourseReportPhotoStorageAuthStatus(): CourseReportPhotoStorageAuthStatus {
  const token = hasLegacyBlobToken();
  const oidc = hasOidcBlobAuth();
  return { ready: token || oidc, oidc, token };
}

export function isCourseReportPhotoStorageConfigured(): boolean {
  return getCourseReportPhotoStorageAuthStatus().ready;
}

const unconfigured: CourseReportPhotoStore = {
  configured: false,
  async put() {
    throw new CourseReportPhotoStorageError(
      "storage_not_configured",
      "사진 저장소가 설정되지 않았습니다.",
      503
    );
  },
  async get() {
    throw new CourseReportPhotoStorageError(
      "storage_not_configured",
      "사진 저장소가 설정되지 않았습니다.",
      503
    );
  },
  async head() {
    throw new CourseReportPhotoStorageError(
      "storage_not_configured",
      "사진 저장소가 설정되지 않았습니다.",
      503
    );
  },
  async readPrefix() {
    throw new CourseReportPhotoStorageError(
      "storage_not_configured",
      "사진 저장소가 설정되지 않았습니다.",
      503
    );
  },
  async delete() {
    throw new CourseReportPhotoStorageError(
      "storage_not_configured",
      "사진 저장소가 설정되지 않았습니다.",
      503
    );
  },
};

async function readLimitedStream(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  abort?: AbortController
): Promise<Uint8Array> {
  const limit = Math.max(0, Math.floor(maxBytes));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  try {
    while (n < limit) {
      const { done, value } = await reader.read();
      if (done || !value || value.byteLength === 0) break;
      const take = Math.min(limit - n, value.byteLength);
      chunks.push(take === value.byteLength ? value : value.subarray(0, take));
      n += take;
      if (take < value.byteLength) break;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
    abort?.abort();
  }
  const out = new Uint8Array(n);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function openVercelBlobStream(
  key: string,
  opts?: PhotoOpenOptions
): Promise<ReadableStream<Uint8Array> | null> {
  if (!isCourseReportPhotoStorageConfigured()) {
    throw new CourseReportPhotoStorageError(
      "storage_not_configured",
      "사진 저장소가 설정되지 않았습니다.",
      503
    );
  }
  try {
    const { get } = await import("@vercel/blob");
    const result = await get(key, {
      access: "private",
      useCache: false,
      abortSignal: opts?.abortSignal,
    });
    if (!result || result.statusCode !== 200 || !result.stream) return null;
    return result.stream;
  } catch (e) {
    const { BlobNotFoundError } = await import("@vercel/blob");
    if (e instanceof BlobNotFoundError) return null;
    if (opts?.abortSignal?.aborted) throw e;
    throw new CourseReportPhotoStorageError(
      "storage_get_failed",
      "사진 읽기에 실패했습니다.",
      502
    );
  }
}

const vercelBlobStore: CourseReportPhotoStore = {
  configured: true,
  async put(key, bytes, mimeType) {
    if (!isCourseReportPhotoStorageConfigured()) {
      throw new CourseReportPhotoStorageError(
        "storage_not_configured",
        "사진 저장소가 설정되지 않았습니다.",
        503
      );
    }
    const { put } = await import("@vercel/blob");
    await put(key, Buffer.from(bytes), {
      access: "private",
      addRandomSuffix: false,
      contentType: mimeType,
      cacheControlMaxAge: 60 * 60 * 24 * 30,
    });
  },
  async createSignedPutUrl(input) {
    if (!isCourseReportPhotoStorageConfigured()) {
      throw new CourseReportPhotoStorageError(
        "storage_not_configured",
        "사진 저장소가 설정되지 않았습니다.",
        503
      );
    }
    try {
      const { issueSignedToken, presignUrl } = await import("@vercel/blob");
      const validUntil = input.validUntilMs;
      const token = await issueSignedToken({
        pathname: input.pathname,
        operations: ["put"],
        allowedContentTypes: [input.contentType],
        maximumSizeInBytes: input.maximumSizeInBytes,
        validUntil,
      });
      const { presignedUrl } = await presignUrl(
        {
          delegationToken: token.delegationToken,
          clientSigningToken: token.clientSigningToken,
        },
        {
          operation: "put",
          pathname: input.pathname,
          access: "private",
          allowedContentTypes: [input.contentType],
          maximumSizeInBytes: input.maximumSizeInBytes,
          addRandomSuffix: false,
          allowOverwrite: false,
          cacheControlMaxAge: 60 * 60 * 24 * 30,
          validUntil,
        }
      );
      return { uploadUrl: presignedUrl, expiresAt: validUntil };
    } catch (e) {
      if (e instanceof CourseReportPhotoStorageError) throw e;
      throw new CourseReportPhotoStorageError(
        "signed_put_failed",
        "사진 업로드 URL 발급에 실패했습니다.",
        502
      );
    }
  },
  async get(key, opts) {
    const stream = await openVercelBlobStream(key, opts);
    if (!stream) return null;
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  },
  async head(key) {
    if (!isCourseReportPhotoStorageConfigured()) {
      throw new CourseReportPhotoStorageError(
        "storage_not_configured",
        "사진 저장소가 설정되지 않았습니다.",
        503
      );
    }
    try {
      const { head } = await import("@vercel/blob");
      const meta = await head(key);
      return { size: meta.size, contentType: meta.contentType || "" };
    } catch (e) {
      const { BlobNotFoundError } = await import("@vercel/blob");
      if (e instanceof BlobNotFoundError) return null;
      throw new CourseReportPhotoStorageError(
        "storage_get_failed",
        "사진 읽기에 실패했습니다.",
        502
      );
    }
  },
  async readPrefix(key, maxBytes) {
    if (!isCourseReportPhotoStorageConfigured()) {
      throw new CourseReportPhotoStorageError(
        "storage_not_configured",
        "사진 저장소가 설정되지 않았습니다.",
        503
      );
    }
    const limit = Math.max(0, Math.floor(maxBytes));
    const { get, BlobNotFoundError } = await import("@vercel/blob");
    const openPrefix = async (range: boolean) => {
      const abort = new AbortController();
      const result = await get(key, {
        access: "private",
        useCache: false,
        abortSignal: abort.signal,
        headers: range && limit > 0 ? { Range: `bytes=0-${limit - 1}` } : undefined,
      });
      if (!result || result.statusCode !== 200 || !result.stream) return null;
      return readLimitedStream(result.stream, limit, abort);
    };
    try {
      return await openPrefix(true);
    } catch (e) {
      if (e instanceof BlobNotFoundError) return null;
      try {
        return await openPrefix(false);
      } catch (retry) {
        if (retry instanceof BlobNotFoundError) return null;
        throw new CourseReportPhotoStorageError(
          "storage_get_failed",
          "사진 읽기에 실패했습니다.",
          502
        );
      }
    }
  },
  async open(key, opts) {
    return openVercelBlobStream(key, opts);
  },
  async delete(key) {
    if (!isCourseReportPhotoStorageConfigured()) {
      throw new CourseReportPhotoStorageError(
        "storage_not_configured",
        "사진 저장소가 설정되지 않았습니다.",
        503
      );
    }
    try {
      const { del } = await import("@vercel/blob");
      await del(key);
    } catch (e) {
      const { BlobNotFoundError } = await import("@vercel/blob");
      if (e instanceof BlobNotFoundError) return;
      throw new CourseReportPhotoStorageError(
        "storage_delete_failed",
        "사진 저장소 삭제에 실패했습니다.",
        502
      );
    }
  },
};

let testOverride: CourseReportPhotoStore | null = null;

export function setCourseReportPhotoStoreForTests(store: CourseReportPhotoStore | null) {
  testOverride = store;
}

export function getCourseReportPhotoStore(): CourseReportPhotoStore {
  if (testOverride) return testOverride;
  if (!isCourseReportPhotoStorageConfigured()) return unconfigured;
  return { ...vercelBlobStore, configured: true };
}

export function createMemoryCourseReportPhotoStore(): CourseReportPhotoStore {
  const objects = new Map<string, { bytes: Uint8Array; mimeType: string }>();
  return {
    configured: true,
    async put(key, bytes, mimeType = "application/octet-stream") {
      objects.set(key, { bytes: Uint8Array.from(bytes), mimeType });
    },
    async get(key) {
      const row = objects.get(key);
      return row ? Uint8Array.from(row.bytes) : null;
    },
    async head(key) {
      const row = objects.get(key);
      if (!row) return null;
      return { size: row.bytes.byteLength, contentType: row.mimeType };
    },
    async readPrefix(key, maxBytes) {
      const row = objects.get(key);
      if (!row) return null;
      const limit = Math.max(0, Math.min(Math.floor(maxBytes), row.bytes.byteLength));
      return Uint8Array.from(row.bytes.subarray(0, limit));
    },
    async delete(key) {
      objects.delete(key);
    },
  };
}
