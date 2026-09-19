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

export type CourseReportPhotoStore = {
  configured: boolean;
  put(key: string, bytes: Uint8Array, mimeType: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
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
  async delete() {
    throw new CourseReportPhotoStorageError(
      "storage_not_configured",
      "사진 저장소가 설정되지 않았습니다.",
      503
    );
  },
};

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
  async get(key) {
    if (!isCourseReportPhotoStorageConfigured()) {
      throw new CourseReportPhotoStorageError(
        "storage_not_configured",
        "사진 저장소가 설정되지 않았습니다.",
        503
      );
    }
    try {
      const { get } = await import("@vercel/blob");
      const result = await get(key, { access: "private", useCache: false });
      if (!result || result.statusCode !== 200 || !result.stream) return null;
      const buf = await new Response(result.stream).arrayBuffer();
      return new Uint8Array(buf);
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
  const objects = new Map<string, Uint8Array>();
  return {
    configured: true,
    async put(key, bytes) {
      objects.set(key, Uint8Array.from(bytes));
    },
    async get(key) {
      const row = objects.get(key);
      return row ? Uint8Array.from(row) : null;
    },
    async delete(key) {
      objects.delete(key);
    },
  };
}
