/**
 * Notice composer clipboard classification.
 *
 * Windows Excel Ctrl+C puts several formats on the OS clipboard (CF_HTML,
 * Unicode text, and often a bitmap / PNG). Chrome and Edge paste events
 * reliably expose `text/html` plus `text/plain`. `image/png` is included for
 * screenshots and copied images, and sometimes for Excel's own bitmap.
 * When both an image and an Excel HTML table are present they are the same
 * selection, so only the image is returned.
 *
 * Generic web tables are not treated as Excel. Nothing here fetches URLs or
 * evaluates markup.
 */

export const NOTICE_PASTE_HINT =
  "사진·스크린샷·엑셀 표를 Ctrl+V로 붙여넣을 수 있습니다.";

export const NOTICE_PASTE_EXCEL_FALLBACK =
  "이 브라우저에서는 엑셀 표를 읽지 못했습니다. Excel에서 '그림으로 복사'를 하거나 화면을 캡처한 뒤 붙여넣어 주세요.";

export const NOTICE_PASTE_TABLE_TOO_LARGE =
  "표가 너무 커서 이미지로 붙이지 못했습니다. 범위를 줄이거나, Excel에서 '그림으로 복사' 또는 화면 캡처 후 붙여넣어 주세요.";

export const NOTICE_PASTE_EXCEL_EMPTY =
  "엑셀 표에서 붙일 셀을 찾지 못했습니다. 셀을 선택한 뒤 다시 복사해 주세요.";

export const NOTICE_PASTE_WHILE_SAVING = "저장 중에는 사진을 추가할 수 없습니다.";

export type NoticeClipboardDecision =
  | { kind: "image"; files: File[] }
  | { kind: "excel-table"; html: string }
  | { kind: "text" }
  | { kind: "unsupported"; message: string };

const IMAGE_MIME_ALIASES: Record<string, string> = {
  "image/png": "image/png",
  "image/x-png": "image/png",
  "image/jpeg": "image/jpeg",
  "image/jpg": "image/jpeg",
  "image/pjpeg": "image/jpeg",
  "image/webp": "image/webp",
  "image/gif": "image/gif",
  "image/bmp": "image/bmp",
  "image/x-ms-bmp": "image/bmp",
};

export function canonicalNoticeImageMime(type: string | null | undefined): string | null {
  const mime = (type || "").split(";")[0].trim().toLowerCase();
  return IMAGE_MIME_ALIASES[mime] ?? null;
}

function excelHead(html: string): string {
  const bodyAt = html.search(/<body[\s>]/i);
  return bodyAt >= 0 ? html.slice(0, bodyAt) : html.slice(0, 30000);
}

function hasExcelHeadMarker(head: string): boolean {
  return (
    /urn:schemas-microsoft-com:office:excel/i.test(head) ||
    /Excel\.Sheet/i.test(head) ||
    /Microsoft Excel/i.test(head) ||
    /mso-number-format/i.test(head)
  );
}

/**
 * Excel HTML, including a headless fragment some browsers return
 * (`class=xl65`, `x:num`) without the document head.
 * Web tables and Google Sheets stay false.
 */
export function isExcelClipboardHtml(html: string): boolean {
  if (!html || !/<table[\s>]/i.test(html)) return false;
  if (/google-sheets-html-origin/i.test(html)) return false;
  if (hasExcelHeadMarker(excelHead(html))) return true;
  return (
    /\bclass\s*=\s*["']?xl\d+/i.test(html) ||
    /\sx:(?:num|str|fmla)\s*=/i.test(html)
  );
}

export function isExcelMarkupWithoutTable(html: string): boolean {
  if (!html || /<table[\s>]/i.test(html)) return false;
  if (/google-sheets-html-origin/i.test(html)) return false;
  return hasExcelHeadMarker(excelHead(html));
}

function withImageMime(file: File, mime: string): File {
  if ((file.type || "").toLowerCase() === mime) return file;
  return new File([file], file.name || "paste.png", {
    type: mime,
    lastModified: file.lastModified || Date.now(),
  });
}

function dedupeImageFiles(files: File[]): File[] {
  const out: File[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    if (!file || file.size <= 0) continue;
    const mime = canonicalNoticeImageMime(file.type);
    if (!mime) continue;
    const normalized = withImageMime(file, mime);
    const id = `${normalized.name}|${normalized.size}|${normalized.lastModified}|${normalized.type}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(normalized);
  }
  return out;
}

export function classifyNoticeClipboard(input: {
  html?: string;
  plain?: string;
  imageFiles?: Array<File | null | undefined>;
}): NoticeClipboardDecision {
  const files = dedupeImageFiles(
    (input.imageFiles ?? []).filter((file): file is File => !!file)
  );
  if (files.length) return { kind: "image", files };
  const html = input.html ?? "";
  if (isExcelClipboardHtml(html)) return { kind: "excel-table", html };
  if (isExcelMarkupWithoutTable(html)) {
    return { kind: "unsupported", message: NOTICE_PASTE_EXCEL_FALLBACK };
  }
  return { kind: "text" };
}

type ClipboardLike = {
  getData?: (type: string) => string;
  items?: ArrayLike<{ kind: string; type: string; getAsFile: () => File | null } | null>;
  files?: ArrayLike<File | null>;
};

function readClipboardString(data: ClipboardLike, type: string): string {
  try {
    return data.getData?.(type) ?? "";
  } catch {
    return "";
  }
}

/** Reads a paste-event DataTransfer. Does not call the async Clipboard API. */
export function noticeClipboardFromData(
  data: ClipboardLike | null | undefined
): { html: string; plain: string; imageFiles: File[] } {
  if (!data) return { html: "", plain: "", imageFiles: [] };
  const imageFiles: File[] = [];
  const items = data.items;
  if (items) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item || item.kind !== "file") continue;
      const mime = canonicalNoticeImageMime(item.type);
      if (!mime) continue;
      let file: File | null = null;
      try {
        file = item.getAsFile();
      } catch {
        file = null;
      }
      if (!file || file.size <= 0) continue;
      imageFiles.push(withImageMime(file, mime));
    }
  }
  const files = data.files;
  if (files) {
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!file || file.size <= 0) continue;
      const mime = canonicalNoticeImageMime(file.type);
      if (!mime) continue;
      imageFiles.push(withImageMime(file, mime));
    }
  }
  return {
    html: readClipboardString(data, "text/html"),
    plain: readClipboardString(data, "text/plain"),
    imageFiles,
  };
}
