/**
 * Server-only CourseReport photo object storage.
 * Client components must never import this module.
 * Token values are never logged.
 */
import { COURSE_REPORT_BLOB_TOKEN_ENV } from "@/lib/courseReportPhotoConstants";

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

function blobToken(): string | null {
  const raw = process.env[COURSE_REPORT_BLOB_TOKEN_ENV];
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  return raw;
}

export function isCourseReportPhotoStorageConfigured(): boolean {
  return blobToken() != null;
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
    const token = blobToken();
    if (!token) {
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
      token,
      cacheControlMaxAge: 60 * 60 * 24 * 30,
    });
  },
  async get(key) {
    const token = blobToken();
    if (!token) {
      throw new CourseReportPhotoStorageError(
        "storage_not_configured",
        "사진 저장소가 설정되지 않았습니다.",
        503
      );
    }
    try {
      const { get } = await import("@vercel/blob");
      const result = await get(key, { access: "private", token, useCache: false });
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
    const token = blobToken();
    if (!token) {
      throw new CourseReportPhotoStorageError(
        "storage_not_configured",
        "사진 저장소가 설정되지 않았습니다.",
        503
      );
    }
    try {
      const { del } = await import("@vercel/blob");
      await del(key, { token });
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
