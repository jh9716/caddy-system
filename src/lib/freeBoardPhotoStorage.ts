/**
 * 자유게시판 사진 저장소 격리 정책 (server-only). 값은 절대 로그/응답에 출력하지 않는다.
 *
 * - VERCEL_ENV=preview (및 development/로컬):
 *     전용 저장소만 허용. 아래가 모두 만족돼야 업로드/조회 가능, 아니면 503 + code.
 *       FREE_BOARD_STORAGE_ENV=preview            (명시적 마커, Preview 범위에만 설정)
 *       FREE_BOARD_BLOB_READ_WRITE_TOKEN 존재     (Preview 전용 Blob store 토큰, Preview 범위에만 설정)
 *       FREE_BOARD_PREVIEW_BLOB_STORE_ID = 토큰의 store id, FREE_BOARD_PRODUCTION_BLOB_STORE_ID 와 다름
 *       (운영 store id 미설정·파싱 불가 등 분리 증명 불가 → 차단, fail-closed)
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
/** 비밀 아님: Preview 전용 store id (토큰의 store id 와 일치해야 함). */
export const FREE_BOARD_PREVIEW_STORE_ID_ENV = "FREE_BOARD_PREVIEW_BLOB_STORE_ID";
/** 비밀 아님: 운영 store id. Preview 에서 반드시 설정 — 없으면 차단. */
export const FREE_BOARD_PRODUCTION_STORE_ID_ENV = "FREE_BOARD_PRODUCTION_BLOB_STORE_ID";
const STORE_ID_RE = /^[a-z0-9]{4,64}$/;

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

/**
 * Fail-closed: 비운영 환경에서는 "운영 store 와 다르다"는 것이 양의 증거로 증명될 때만 허용.
 * 필요 (모두 Preview 범위 env):
 *   FREE_BOARD_STORAGE_ENV=preview
 *   FREE_BOARD_BLOB_READ_WRITE_TOKEN          (Preview 전용 store 토큰, 형식 파싱 가능해야 함)
 *   FREE_BOARD_PREVIEW_BLOB_STORE_ID          (비밀 아님. 토큰에서 파싱한 store id 와 일치해야 함)
 *   FREE_BOARD_PRODUCTION_BLOB_STORE_ID       (비밀 아님. 운영 store id. 반드시 존재, preview 와 달라야 함)
 * 추가로 공용 BLOB_READ_WRITE_TOKEN / BLOB_STORE_ID 가 존재하면 파싱 가능해야 하고 preview 와 달라야 함.
 * 파싱 실패·누락·불일치 등 하나라도 증명 불가 → 차단 (503 + 안전 코드). 값은 어디에도 출력하지 않는다.
 */
export function resolveFreeBoardStorageDecision(env: Env = process.env): FreeBoardStorageDecision {
  const vercelEnv = (env.VERCEL_ENV || "").trim();
  const marker = (env[FREE_BOARD_STORAGE_ENV_MARKER] || "").trim();
  if (vercelEnv === "production") {
    if (marker === "preview") {
      return blocked("free_board_storage_env_mismatch", "사진 저장소 환경 설정이 올바르지 않습니다.");
    }
    return { ok: true, mode: "shared" };
  }
  const missing = () =>
    blocked("free_board_preview_storage_missing", "Preview 전용 사진 저장소가 설정되지 않았습니다.");
  const unproven = () =>
    blocked(
      "free_board_storage_isolation_unproven",
      "Preview 사진 저장소가 운영 저장소와 분리되어 있음을 확인할 수 없습니다."
    );
  const shared = () =>
    blocked("free_board_storage_shared", "Preview 사진 저장소가 운영 저장소와 같습니다.");

  if (marker !== "preview") return missing();
  const token = env[FREE_BOARD_BLOB_TOKEN_ENV];
  if (!nonEmpty(token)) return missing();
  const previewFromToken = blobStoreIdFromToken(token);
  if (!previewFromToken) {
    return blocked("free_board_storage_token_invalid", "Preview 사진 저장소 설정 형식이 올바르지 않습니다.");
  }
  // 명시적 allowlist: 선언된 preview store id 와 토큰의 store id 가 일치
  const declaredPreview = normalizeStoreId(env[FREE_BOARD_PREVIEW_STORE_ID_ENV]);
  if (!declaredPreview || !STORE_ID_RE.test(declaredPreview)) return unproven();
  if (declaredPreview !== previewFromToken) return unproven();
  // 운영 store id 는 반드시 알려져 있어야 함 (없으면 비교 불가 → 차단)
  const production = normalizeStoreId(env[FREE_BOARD_PRODUCTION_STORE_ID_ENV]);
  if (!production || !STORE_ID_RE.test(production)) return unproven();
  if (production === previewFromToken) return shared();
  // 공용 자격 증명이 Preview env 에 있으면 그것과도 달라야 함 (파싱 불가면 증명 불가)
  const sharedToken = env.BLOB_READ_WRITE_TOKEN;
  if (nonEmpty(sharedToken)) {
    if (sharedToken.trim() === token.trim()) return shared();
    const sharedId = blobStoreIdFromToken(sharedToken);
    if (!sharedId) return unproven();
    if (sharedId === previewFromToken) return shared();
  }
  if (nonEmpty(env.BLOB_STORE_ID)) {
    const sid = normalizeStoreId(env.BLOB_STORE_ID);
    if (!sid || !STORE_ID_RE.test(sid)) return unproven();
    if (sid === previewFromToken) return shared();
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

/** 자유게시판 key 형식: free-board/<postId>/<uuid>.<ext> 만 허용. notices/·course-reports/ 등 접근 불가. */
export const FREE_BOARD_KEY_RE =
  /^free-board\/[1-9][0-9]{0,9}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$/;

function assertKey(key: string) {
  if (!FREE_BOARD_KEY_RE.test(key)) throw new Error("free_board_key_rejected");
}

/** 모든 store 호출을 free-board/<postId>/ key 로 제한하는 래퍼. */
export function guardFreeBoardStore(inner: CourseReportPhotoStore): CourseReportPhotoStore {
  return {
    configured: inner.configured,
    async put(key, bytes, mime) {
      assertKey(key);
      return inner.put(key, bytes, mime);
    },
    async get(key, opts) {
      assertKey(key);
      return inner.get(key, opts);
    },
    ...(inner.open
      ? {
          async open(key: string, opts?: PhotoOpenOptions) {
            assertKey(key);
            return inner.open!(key, opts);
          },
        }
      : {}),
    async delete(key) {
      assertKey(key);
      return inner.delete(key);
    },
    async head(key) {
      assertKey(key);
      return inner.head(key);
    },
    async readPrefix(key, n) {
      assertKey(key);
      return inner.readPrefix(key, n);
    },
  };
}

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
    return { ok: true, mode: "dedicated", store: guardFreeBoardStore(store) };
  }
  const store = testFactory ? testFactory.shared() : getCourseReportPhotoStore();
  if (!store.configured) {
    return { ok: false, code: "storage_not_configured", message: "사진 저장소가 설정되지 않았습니다." };
  }
  return { ok: true, mode: "shared", store: guardFreeBoardStore(store) };
}
