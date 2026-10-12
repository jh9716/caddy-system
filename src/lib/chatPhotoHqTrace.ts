import { isPreview296BrowserHost, isProductionWebHost } from "@/lib/preview296Isolation";
import {
  parseNativeChatPhotoHqReady,
  planNativeHqUpgrade,
  type NativeChatPhotoHqReadyPayload,
  type NativePreviewAttachmentMap,
} from "@/lib/chatPhotoNativePreview";

export const HQ_TRACE_STAGES = [
  "native_hq",
  "hq_event",
  "hq_parse",
  "map_lookup",
  "start_upgrade",
  "upgrade_grant",
  "upgrade_put",
  "upgrade_finalize",
] as const;

export type HqTraceStage = (typeof HQ_TRACE_STAGES)[number];

export type HqTraceRow = {
  stage: HqTraceStage;
  previewId?: string;
  attachmentId?: string;
  ok?: boolean;
  width?: number;
  height?: number;
  bytes?: number;
  status?: number;
  size?: number;
  jsBuilt?: boolean;
  mapHit?: boolean;
  called?: boolean;
  at: number;
};

const PREVIEW_ID_RE = /^nvp-\d+-[a-z0-9]+$/i;
const ATTACHMENT_ID_RE = /^[a-z0-9][a-z0-9._-]{7,80}$/i;

let rows: HqTraceRow[] = [];
const listeners = new Set<() => void>();

export function canShowHqTrace(host?: string | null): boolean {
  const h = String(
    host ?? (typeof window !== "undefined" ? window.location.hostname : "")
  )
    .trim()
    .toLowerCase();
  if (!h || isProductionWebHost(h)) return false;
  if (h === "caddy-system-gt8t.vercel.app") return false;
  return isPreview296BrowserHost(h);
}

function finiteInt(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : undefined;
}

function sanitizePreviewId(value: unknown): string | undefined {
  const id = typeof value === "string" ? value.trim() : "";
  return PREVIEW_ID_RE.test(id) ? id : undefined;
}

function sanitizeAttachmentId(value: unknown): string | undefined {
  const id = typeof value === "string" ? value.trim() : "";
  return ATTACHMENT_ID_RE.test(id) ? id : undefined;
}

export function resetHqTrace(): void {
  rows = [];
  for (const listener of listeners) listener();
}

export function getHqTraceRows(): HqTraceRow[] {
  return rows.slice();
}

export function subscribeHqTrace(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function recordHqTrace(
  input: Omit<HqTraceRow, "at"> & { at?: number },
  host?: string | null
): boolean {
  if (!canShowHqTrace(host)) return false;
  if (!HQ_TRACE_STAGES.includes(input.stage)) return false;
  const row: HqTraceRow = {
    stage: input.stage,
    at: Number.isFinite(input.at) ? Number(input.at) : Date.now(),
  };
  const previewId = sanitizePreviewId(input.previewId);
  if (previewId) row.previewId = previewId;
  const attachmentId = sanitizeAttachmentId(input.attachmentId);
  if (attachmentId) row.attachmentId = attachmentId;
  if (typeof input.ok === "boolean") row.ok = input.ok;
  if (typeof input.jsBuilt === "boolean") row.jsBuilt = input.jsBuilt;
  if (typeof input.mapHit === "boolean") row.mapHit = input.mapHit;
  if (typeof input.called === "boolean") row.called = input.called;
  const width = finiteInt(input.width);
  const height = finiteInt(input.height);
  const bytes = finiteInt(input.bytes);
  const status = finiteInt(input.status);
  const size = finiteInt(input.size);
  if (width != null) row.width = width;
  if (height != null) row.height = height;
  if (bytes != null) row.bytes = bytes;
  if (status != null) row.status = status;
  if (size != null) row.size = size;
  rows = [...rows.slice(-39), row];
  for (const listener of listeners) listener();
  return true;
}

export function formatHqTraceLine(row: HqTraceRow): string {
  const parts = [row.stage];
  if (row.previewId) parts.push(row.previewId);
  if (row.attachmentId) parts.push(row.attachmentId);
  if (row.width != null && row.height != null) parts.push(`${row.width}x${row.height}`);
  if (row.bytes != null) parts.push(`b=${row.bytes}`);
  if (row.size != null) parts.push(`size=${row.size}`);
  if (row.status != null) parts.push(`http=${row.status}`);
  if (typeof row.jsBuilt === "boolean") parts.push(`js=${row.jsBuilt ? "ok" : "fail"}`);
  if (typeof row.mapHit === "boolean") parts.push(row.mapHit ? "map=hit" : "map=miss");
  if (typeof row.called === "boolean") parts.push(row.called ? "called=yes" : "called=no");
  if (typeof row.ok === "boolean") parts.push(row.ok ? "ok" : "fail");
  return parts.join(" ");
}

export function observeHqReadyForTrace(input: {
  raw: unknown;
  map: NativePreviewAttachmentMap;
  abandonedIds?: ReadonlySet<string>;
  host?: string | null;
}): {
  parsed: NativeChatPhotoHqReadyPayload | null;
  planned: ReturnType<typeof planNativeHqUpgrade> | null;
} {
  const raw = input.raw && typeof input.raw === "object" ? (input.raw as Record<string, unknown>) : {};
  const previewId = sanitizePreviewId(raw.previewId);
  const width = finiteInt(raw.width);
  const height = finiteInt(raw.height);
  const bytes = finiteInt(raw.bytes);
  const jsBuilt =
    typeof raw.dataUrl === "string" && raw.dataUrl.startsWith("data:image/jpeg;base64,") && !raw.error;
  recordHqTrace(
    {
      stage: "native_hq",
      previewId,
      width,
      height,
      bytes,
      jsBuilt,
      ok: jsBuilt,
    },
    input.host
  );
  recordHqTrace(
    {
      stage: "hq_event",
      previewId,
      width,
      height,
      bytes,
      ok: Boolean(previewId),
    },
    input.host
  );
  const parsed = parseNativeChatPhotoHqReady(input.raw);
  recordHqTrace(
    {
      stage: "hq_parse",
      previewId: parsed?.previewId || previewId,
      width: parsed?.width ?? width,
      height: parsed?.height ?? height,
      bytes: parsed?.bytes ?? bytes,
      ok: Boolean(parsed),
    },
    input.host
  );
  if (!parsed) return { parsed: null, planned: null };
  const planned = planNativeHqUpgrade({
    previewId: parsed.previewId,
    map: input.map,
    abandonedIds: input.abandonedIds,
  });
  recordHqTrace(
    {
      stage: "map_lookup",
      previewId: parsed.previewId,
      attachmentId: planned.attachmentId || undefined,
      mapHit: planned.action === "upgrade",
      ok: planned.action === "upgrade",
    },
    input.host
  );
  return { parsed, planned };
}

export function noteHqUpgradeCall(
  input: { previewId?: string; attachmentId?: string; called: boolean },
  host?: string | null
): boolean {
  return recordHqTrace(
    {
      stage: "start_upgrade",
      previewId: input.previewId,
      attachmentId: input.attachmentId,
      called: input.called,
      ok: input.called,
    },
    host
  );
}
