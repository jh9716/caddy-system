/**
 * 자유게시판 사진 저장소 격리 정책 (server-only). 값은 절대 로그/응답에 출력하지 않는다.
 *
 * - VERCEL_ENV=preview (및 development/로컬):
 *     전용 저장소만 허용. 아래가 모두 만족돼야 업로드/조회 가능, 아니면 503 + code.
 *       FREE_BOARD_STORAGE_ENV=preview            (명시적 마커, Preview 범위에만 설정)
 *       FREE_BOARD_BLOB_READ_WRITE_TOKEN 존재     (Preview 전용 Blob store 토큰, Preview 범위에만 설정)
 *       그 토큰의 store id 가 공용 BLOB_READ_WRITE_TOKEN / BLOB_STORE_ID 의 store 와 다름
 *     공용 BLOB_READ_WRITE_TOKEN / OIDC 로 절대 fallback 하지 않는다.
 * - VERCEL_ENV=production:
 *     기존 공용 사진 저장소(공지·코스제보와 같은 store)를 free-board/ prefix 로 사용.
 *     FREE_BOARD_STORAGE_ENV=preview 마커가 잘못 들어와 있으면 차단.
 */
import {
  getCourseReportPhotoStore,
  type CourseReportPhotoStore,
  type PhotoOpenOptions,
} from "@/lib/courseReportPhotoStorage";

export const FREE_BOARD_BLOB_TOKEN_ENV = "FREE_BOARD_BLOB_READ_WRITE_TOKEN";
export const FREE_BOARD_STORAGE_ENV_MARKER = "FREE_BOARD_STORAGE_ENV";

export type FreeBoardStorageDecision =
  | { ok: true; mode: "dedicated" | "shared" }
  | { ok: false; code: string; message: string };

type Env = Record<string, string | undefined>;

function nonEmpty(v: string | undefined): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/** vercel_blob_rw_<storeId>_<secret> → storeId (소문자). 형식 불명이면 null. 값 출력 금지. */
export function blobStoreIdFromToken(token: string | undefined): string | null {
  if (!nonEmpty(token)) return null;
  const m = /^vercel_blob_rw_([A-Za-z0-9]+)_/.exec(token.trim());
  return m ? m[1].toLowerCase() : null;
}

function normalizeStoreId(id: string | undefined): string | null {
  if (!nonEmpty(id)) return null;
  return id.trim().replace(/^store_/i, "").toLowerCase();
}

const blocked = (code: string, message: string): FreeBoardStorageDecision => ({
  ok: false,
  code,
  message,
});

export function resolveFreeBoardStorageDecision(env: Env = process.env): FreeBoardStorageDecision {
  const vercelEnv = (env.VERCEL_ENV || "").trim();
  const marker = (env[FREE_BOARD_STORAGE_ENV_MARKER] || "").trim();
  if (vercelEnv === "production") {
    if (marker === "preview") {
      return blocked(
        "free_board_storage_env_mismatch",
        "사진 저장소 환경 설정이 올바르지 않습니다."
      );
    }
    return { ok: true, mode: "shared" };
  }
  // preview / development / local: 전용 저장소만
  if (marker !== "preview") {
    return blocked(
      "free_board_preview_storage_missing",
      "Preview 전용 사진 저장소가 설정되지 않았습니다."
    );
  }
  const token = env[FREE_BOARD_BLOB_TOKEN_ENV];
  if (!nonEmpty(token)) {
    return blocked(
      "free_board_preview_storage_missing",
      "Preview 전용 사진 저장소가 설정되지 않았습니다."
    );
  }
  const shared = env.BLOB_READ_WRITE_TOKEN;
  if (nonEmpty(shared) && shared.trim() === token.trim()) {
    return blocked(
      "free_board_storage_shared",
      "Preview 사진 저장소가 운영 저장소와 같습니다."
    );
  }
  const dedicatedStore = blobStoreIdFromToken(token);
  if (!dedicatedStore) {
    return blocked(
      "free_board_storage_token_invalid",
      "Preview 사진 저장소 설정 형식이 올바르지 않습니다."
    );
  }
  const sharedStores = [blobStoreIdFromToken(shared), normalizeStoreId(env.BLOB_STORE_ID)].filter(
    Boolean
  );
  if (sharedStores.includes(dedicatedStore)) {
    return blocked(
      "free_board_storage_shared",
      "Preview 사진 저장소가 운영 저장소와 같습니다."
    );
  }
  return { ok: true, mode: "dedicated" };
}

/** 전용 토큰을 명시적으로 넘기는 Blob store. 공용 토큰/OIDC 사용 안 함. */
function dedicatedBlobStore(token: string): CourseReportPhotoStore {
  const fail = (): never => {
    throw new Error("unsupported");
  };
  return {
    configured: true,
    async put(key, bytes, mimeType) {
      const { put } = await import("@vercel/blob");
      await put(key, Buffer.from(bytes), {
        access: "private",
        addRandomSuffix: false,
        contentType: mimeType,
        token,
      });
    },
    async open(key, opts?: PhotoOpenOptions) {
      const { get, BlobNotFoundError } = await import("@vercel/blob");
      try {
        const r = await get(key, {
          access: "private",
          useCache: false,
          abortSignal: opts?.abortSignal,
          token,
        });
        if (!r || r.statusCode !== 200 || !r.stream) return null;
        return r.stream;
      } catch (e) {
        if (e instanceof BlobNotFoundError) return null;
        throw e;
      }
    },
    async get(key, opts) {
      const s = await this.open!(key, opts);
      if (!s) return null;
      if (s instanceof Uint8Array) return s;
      return new Uint8Array(await new Response(s as ReadableStream).arrayBuffer());
    },
    async delete(key) {
      const { del, BlobNotFoundError } = await import("@vercel/blob");
      try {
        await del(key, { token });
      } catch (e) {
        if (e instanceof BlobNotFoundError) return;
        throw e;
      }
    },
    head: fail,
    readPrefix: fail,
  };
}

type StoreFactory = {
  dedicated: () => CourseReportPhotoStore;
  shared: () => CourseReportPhotoStore;
};

let testFactory: StoreFactory | null = null;

/** 테스트 전용: 실제 Blob 대신 mock store 주입. 정책 판정은 그대로 적용된다. */
export function setFreeBoardStoreFactoryForTests(f: StoreFactory | null) {
  testFactory = f;
}

export type FreeBoardStoreResult =
  | { ok: true; mode: "dedicated" | "shared"; store: CourseReportPhotoStore }
  | { ok: false; code: string; message: string };

export function getFreeBoardPhotoStore(env: Env = process.env): FreeBoardStoreResult {
  const d = resolveFreeBoardStorageDecision(env);
  if (!d.ok) return d;
  if (d.mode === "dedicated") {
    const store = testFactory
      ? testFactory.dedicated()
      : dedicatedBlobStore(String(env[FREE_BOARD_BLOB_TOKEN_ENV]).trim());
    return { ok: true, mode: "dedicated", store };
  }
  const store = testFactory ? testFactory.shared() : getCourseReportPhotoStore();
  if (!store.configured) {
    return { ok: false, code: "storage_not_configured", message: "사진 저장소가 설정되지 않았습니다." };
  }
  return { ok: true, mode: "shared", store };
}
