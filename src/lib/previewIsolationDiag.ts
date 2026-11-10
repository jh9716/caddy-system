/**
 * TEMPORARY Preview isolation probe for PR #371.
 * Remove this module (and the /api/_preview-isolation-diag route) before
 * merging to main. It never logs or returns DATABASE_URL, passwords, tokens,
 * connection strings, or hostnames.
 */

export const PREVIEW_ISOLATION_BRANCH =
  "cursor/notice-file-office-attachments-ee9e";

export const PREVIEW_DB_HOST =
  "ep-odd-voice-aokrqp5t.c-2.ap-southeast-1.aws.neon.tech";

export const PREVIEW_DB_POOLER_HOST =
  "ep-odd-voice-aokrqp5t-pooler.c-2.ap-southeast-1.aws.neon.tech";

export const PRODUCTION_DB_ENDPOINT_MARKER = "ep-crimson-cell-a1i1tpce";

export const PREVIEW_BLOB_STORE_ID = "store_tQmS6vVoorlWa5qf";

export const PRODUCTION_BLOB_STORE_ID = "store_Sf4EWIXGqsTWhwjL";

export type PreviewIsolationFlags = {
  previewRuntime: boolean;
  previewDbMatch: boolean;
  previewBlobMatch: boolean;
  safeToTest: boolean;
};

const PREVIEW_DB_HOSTS = new Set([PREVIEW_DB_HOST, PREVIEW_DB_POOLER_HOST]);

function normalizeVercelEnv(raw: string | undefined): string {
  return String(raw ?? "").trim().toLowerCase();
}

function normalizeBranch(raw: string | undefined): string {
  return String(raw ?? "")
    .trim()
    .replace(/^refs\/heads\//, "");
}

function hostnameOnly(databaseUrl: string | undefined): string | null {
  if (typeof databaseUrl !== "string" || databaseUrl.length === 0) return null;
  try {
    const host = new URL(databaseUrl).hostname.trim().toLowerCase();
    return host.length > 0 ? host : null;
  } catch {
    return null;
  }
}

function mentionsProductionEndpoint(
  databaseUrl: string | undefined,
  host: string | null
): boolean {
  const marker = PRODUCTION_DB_ENDPOINT_MARKER;
  if (host && host.includes(marker)) return true;
  if (typeof databaseUrl === "string" && databaseUrl.toLowerCase().includes(marker)) {
    return true;
  }
  return false;
}

export function previewIsolationEnabled(env: NodeJS.Dict<string> = process.env): boolean {
  return (
    normalizeVercelEnv(env.VERCEL_ENV) === "preview" &&
    normalizeBranch(env.VERCEL_GIT_COMMIT_REF) === PREVIEW_ISOLATION_BRANCH
  );
}

export function inspectPreviewIsolation(
  env: NodeJS.Dict<string> = process.env
): PreviewIsolationFlags {
  const previewRuntime = normalizeVercelEnv(env.VERCEL_ENV) === "preview";
  const onPrBranch =
    normalizeBranch(env.VERCEL_GIT_COMMIT_REF) === PREVIEW_ISOLATION_BRANCH;

  const databaseUrl = env.DATABASE_URL;
  const host = hostnameOnly(databaseUrl);
  const previewDbMatch =
    !mentionsProductionEndpoint(databaseUrl, host) &&
    host !== null &&
    PREVIEW_DB_HOSTS.has(host);

  const blobId = String(env.BLOB_STORE_ID ?? "").trim();
  const previewBlobMatch =
    blobId === PREVIEW_BLOB_STORE_ID && blobId !== PRODUCTION_BLOB_STORE_ID;

  return {
    previewRuntime,
    previewDbMatch,
    previewBlobMatch,
    safeToTest:
      previewRuntime && onPrBranch && previewDbMatch && previewBlobMatch,
  };
}
