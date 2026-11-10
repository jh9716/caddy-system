/**
 * Turns an Excel clipboard HTML table into one PNG.
 *
 * The HTML is scanned as text. It is never inserted into the document, and
 * scripts, iframes, and stylesheet URLs are not loaded. Cell text, colors,
 * borders, alignment, and spans are redrawn on a canvas at a scale that stays
 * readable when the notice photo is opened on a phone.
 */

import {
  NOTICE_PASTE_EXCEL_EMPTY,
  NOTICE_PASTE_EXCEL_FALLBACK,
  NOTICE_PASTE_TABLE_TOO_LARGE,
  isExcelClipboardHtml,
} from "@/lib/noticeClipboardPaste";

export const EXCEL_TABLE_MAX_ROWS = 80;
export const EXCEL_TABLE_MAX_COLS = 30;
export const EXCEL_TABLE_MAX_CELLS = 1600;
export const EXCEL_TABLE_MAX_HTML_CHARS = 1_500_000;
export const EXCEL_TABLE_MAX_LONG_EDGE = 4096;
export const EXCEL_TABLE_MIN_LONG_EDGE = 1400;
export const EXCEL_TABLE_MAX_SCALE = 4;

const FONT_FALLBACK =
  '"Malgun Gothic", "맑은 고딕", "Apple SD Gothic Neo", "Noto Serif KR", "Noto Sans KR", sans-serif';

export class NoticeExcelPasteError extends Error {
  readonly code: "not-excel" | "too-large" | "empty" | "render";

  constructor(message: string, code: NoticeExcelPasteError["code"]) {
    super(message);
    this.name = "NoticeExcelPasteError";
    this.code = code;
  }
}

export type ExcelBorder = {
  widthPx: number;
  color: string;
  dashed: boolean;
};

export type ExcelTextAlign = "left" | "center" | "right" | "auto";
export type ExcelVerticalAlign = "top" | "middle" | "bottom";

export type ExcelCellStyle = {
  color: string;
  background: string | null;
  fontSizePx: number;
  fontWeight: string;
  fontStyle: "normal" | "italic";
  fontFamily: string;
  textAlign: ExcelTextAlign;
  verticalAlign: ExcelVerticalAlign;
  wrap: boolean;
  borderTop: ExcelBorder | null;
  borderRight: ExcelBorder | null;
  borderBottom: ExcelBorder | null;
  borderLeft: ExcelBorder | null;
};

export type ExcelTableCell = {
  text: string;
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
  style: ExcelCellStyle;
};

export type ExcelTableModel = {
  rows: number;
  cols: number;
  colWidths: number[];
  rowHeights: number[];
  cells: ExcelTableCell[];
};

type Decl = { prop: string; value: string };

const NAMED_COLORS: Record<string, string> = {
  black: "#000000",
  white: "#ffffff",
  red: "#ff0000",
  blue: "#0000ff",
  green: "#008000",
  yellow: "#ffff00",
  gray: "#808080",
  grey: "#808080",
  silver: "#c0c0c0",
  maroon: "#800000",
  navy: "#000080",
  olive: "#808000",
  purple: "#800080",
  teal: "#008080",
  fuchsia: "#ff00ff",
  aqua: "#00ffff",
  orange: "#ffa500",
  lime: "#00ff00",
  windowtext: "#000000",
  buttontext: "#000000",
  window: "#ffffff",
  buttonface: "#f0f0f0",
};

const UNSAFE_VALUE = /url\s*\(|expression\s*\(|javascript:|@import|<\/|<\s*script/i;
const VOID_TAGS = new Set(["col", "br", "img", "meta", "link", "input", "hr", "wbr"]);

function roundPx(n: number): number {
  return Math.round(n * 100) / 100;
}

export function excelLengthToPx(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = value.trim().toLowerCase().match(/^(-?\d*\.?\d+)(pt|px|in|cm|mm)?$/);
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isFinite(n) || n < 0) return null;
  const unit = match[2] || "px";
  if (unit === "px") return n;
  if (unit === "pt") return (n * 96) / 72;
  if (unit === "in") return n * 96;
  if (unit === "cm") return (n * 96) / 2.54;
  if (unit === "mm") return (n * 96) / 25.4;
  return null;
}

export function parseExcelColor(value: string | null | undefined): string | null {
  if (!value) return null;
  const token = value.trim().toLowerCase();
  if (!token || token === "transparent" || token === "auto" || token === "inherit") return null;
  if (UNSAFE_VALUE.test(token)) return null;
  const named = NAMED_COLORS[token];
  if (named) return named;
  const hex = token.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
  if (hex) {
    const body = hex[1];
    if (body.length === 3) {
      return `#${body[0]}${body[0]}${body[1]}${body[1]}${body[2]}${body[2]}`;
    }
    return `#${body.toLowerCase()}`;
  }
  const rgb = token.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i);
  if (!rgb) return null;
  const parts = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])].map((n) =>
    Math.max(0, Math.min(255, n))
  );
  return `#${parts.map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

function parseBackground(value: string): string | null {
  if (UNSAFE_VALUE.test(value)) return null;
  for (const token of value.split(/\s+/)) {
    const color = parseExcelColor(token);
    if (color) return color;
  }
  return null;
}

export function parseExcelBorder(value: string | null | undefined): ExcelBorder | null {
  if (!value) return null;
  if (UNSAFE_VALUE.test(value)) return null;
  const raw = value.trim().toLowerCase();
  if (!raw || raw === "none" || raw === "hidden" || raw === "0") return null;
  let width: number | null = null;
  let color: string | null = null;
  let lineStyle = "solid";
  for (const part of raw.split(/\s+/)) {
    if (/^(none|hidden|solid|dashed|dotted|double)$/.test(part)) {
      lineStyle = part;
      continue;
    }
    if (width == null && /pt|px|in|cm|mm/.test(part)) {
      const len = excelLengthToPx(part);
      if (len != null) {
        width = len;
        continue;
      }
    }
    const parsed = parseExcelColor(part);
    if (parsed) color = parsed;
  }
  if (lineStyle === "none" || lineStyle === "hidden") return null;
  if (width == null || width <= 0) width = roundPx((0.5 * 96) / 72);
  return {
    widthPx: roundPx(width),
    color: color || "#000000",
    dashed: lineStyle === "dashed" || lineStyle === "dotted",
  };
}

export function isExcelNumericText(text: string): boolean {
  const value = text.trim();
  if (!value || value.includes("\n")) return false;
  return (
    /^[-+]?[$₩¥€]?\s*\d{1,3}(?:,\d{3})+(?:\.\d+)?%?$/.test(value) ||
    /^[-+]?\d+(?:\.\d+)?%?$/.test(value)
  );
}

export function resolveExcelTextAlign(
  align: ExcelTextAlign,
  text: string
): "left" | "center" | "right" {
  if (align !== "auto") return align;
  return isExcelNumericText(text) ? "right" : "left";
}

function defaultStyle(): ExcelCellStyle {
  return {
    color: "#000000",
    background: null,
    fontSizePx: roundPx((11 * 96) / 72),
    fontWeight: "400",
    fontStyle: "normal",
    fontFamily: FONT_FALLBACK,
    textAlign: "auto",
    verticalAlign: "middle",
    wrap: false,
    borderTop: null,
    borderRight: null,
    borderBottom: null,
    borderLeft: null,
  };
}

function cloneStyle(style: ExcelCellStyle): ExcelCellStyle {
  return {
    ...style,
    borderTop: style.borderTop ? { ...style.borderTop } : null,
    borderRight: style.borderRight ? { ...style.borderRight } : null,
    borderBottom: style.borderBottom ? { ...style.borderBottom } : null,
    borderLeft: style.borderLeft ? { ...style.borderLeft } : null,
  };
}

function decodeEntities(text: string): string {
  const named = text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeCodePoint(Number.parseInt(dec, 10)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'");
  return named.replace(/&amp;/gi, "&");
}

function safeCodePoint(cp: number): string {
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return "";
  if (cp >= 0xd800 && cp <= 0xdfff) return "";
  try {
    return String.fromCodePoint(cp);
  } catch {
    return "";
  }
}

function cellText(inner: string): string {
  const withoutActive = inner
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<img\b[^>]*>/gi, "")
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, "")
    .replace(/<object\b[^>]*>[\s\S]*?<\/object>/gi, "");
  const withBreaks = withoutActive
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n");
  const stripped = decodeEntities(withBreaks.replace(/<[^>]+>/g, ""));
  return stripped
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 4000);
}

function findTagEnd(html: string, start: number): number {
  let quote = "";
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (quote) {
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ">") return i;
  }
  return -1;
}

type TagBlock = {
  attrSource: string;
  inner: string;
  start: number;
  end: number;
};

function scanBlocks(html: string, tag: string): TagBlock[] {
  const want = tag.toLowerCase();
  const blocks: TagBlock[] = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) break;
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    const tagEnd = findTagEnd(html, lt);
    if (tagEnd < 0) break;
    const raw = html.slice(lt + 1, tagEnd).trim();
    const name = raw.match(/^\/?\s*([a-z0-9:-]+)/i)?.[1]?.toLowerCase() ?? "";
    if (raw.startsWith("/") || name !== want) {
      i = tagEnd + 1;
      continue;
    }
    const selfClose = /\/$/.test(raw) || VOID_TAGS.has(name);
    if (selfClose) {
      blocks.push({ attrSource: raw, inner: "", start: lt, end: tagEnd + 1 });
      i = tagEnd + 1;
      continue;
    }
    const close = findMatchingClose(html, name, tagEnd + 1);
    if (!close) break;
    blocks.push({
      attrSource: raw,
      inner: html.slice(tagEnd + 1, close.contentStart),
      start: lt,
      end: close.end,
    });
    i = close.end;
  }
  return blocks;
}

function findMatchingClose(
  html: string,
  tag: string,
  from: number
): { contentStart: number; end: number } | null {
  let depth = 1;
  let i = from;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) return null;
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    const tagEnd = findTagEnd(html, lt);
    if (tagEnd < 0) return null;
    const raw = html.slice(lt + 1, tagEnd).trim();
    const name = raw.match(/^\/?\s*([a-z0-9:-]+)/i)?.[1]?.toLowerCase() ?? "";
    const closing = raw.startsWith("/");
    if (name === tag) {
      if (closing) {
        depth -= 1;
        if (depth === 0) return { contentStart: lt, end: tagEnd + 1 };
      } else if (!/\/$/.test(raw) && !VOID_TAGS.has(name)) {
        depth += 1;
      }
    }
    i = tagEnd + 1;
  }
  return null;
}

function parseAttributes(raw: string): Record<string, string> {
  const body = raw.replace(/^\/?\s*[a-z0-9:-]+\s*/i, "");
  const attrs: Record<string, string> = {};
  const re = /([:@a-z0-9_-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body))) {
    const key = match[1].toLowerCase();
    attrs[key] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return attrs;
}

function splitDeclarations(body: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote = "";
  for (const ch of body) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ";") {
      if (current.trim()) out.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

function parseDecls(body: string): Decl[] {
  const decls: Decl[] = [];
  for (const part of splitDeclarations(body)) {
    const colon = part.indexOf(":");
    if (colon <= 0) continue;
    const prop = part.slice(0, colon).trim().toLowerCase();
    const value = part.slice(colon + 1).trim();
    if (!prop || !value || UNSAFE_VALUE.test(value)) continue;
    if (prop.startsWith("mso-") || prop.startsWith("-")) continue;
    decls.push({ prop, value });
  }
  return decls;
}

function selectorKey(selector: string): string | null {
  const trimmed = selector.trim();
  if (!trimmed || /[:\[\]>+*~\s]/.test(trimmed)) return null;
  const match = trimmed.match(/^(td|th|tr|table|col)?(\.[A-Za-z0-9_-]+)?$/i);
  if (!match || (!match[1] && !match[2])) return null;
  return `${match[1] ? match[1].toLowerCase() : ""}${match[2] ?? ""}`;
}

function parseStyleRules(css: string): Map<string, Decl[]> {
  const cleaned = css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/<!--/g, "")
    .replace(/-->/g, "");
  const rules = new Map<string, Decl[]>();
  let i = 0;
  while (i < cleaned.length) {
    const open = cleaned.indexOf("{", i);
    if (open < 0) break;
    const selectorText = cleaned.slice(i, open);
    const close = cleaned.indexOf("}", open + 1);
    if (close < 0) break;
    if (!selectorText.includes("@")) {
      const decls = parseDecls(cleaned.slice(open + 1, close));
      for (const part of selectorText.split(",")) {
        const key = selectorKey(part);
        if (!key || !decls.length) continue;
        rules.set(key, (rules.get(key) ?? []).concat(decls));
      }
    }
    i = close + 1;
  }
  return rules;
}

function extractStyleText(html: string): string {
  const chunks: string[] = [];
  for (const block of scanBlocks(html, "style")) {
    chunks.push(block.inner);
  }
  return chunks.join("\n");
}

function applyDecls(style: ExcelCellStyle, decls: Decl[]) {
  for (const decl of decls) {
    const { prop, value } = decl;
    if (prop === "color") {
      const color = parseExcelColor(value);
      if (color) style.color = color;
    } else if (prop === "background" || prop === "background-color") {
      const background = parseBackground(value);
      style.background = background;
    } else if (prop === "font-size") {
      const size = excelLengthToPx(value);
      if (size && size > 0) style.fontSizePx = roundPx(Math.min(size, 96));
    } else if (prop === "font-weight") {
      const weight = value.toLowerCase();
      if (weight === "bold" || weight === "bolder") style.fontWeight = "700";
      else if (weight === "normal" || weight === "lighter") style.fontWeight = "400";
      else if (/^[1-9]00$/.test(weight)) style.fontWeight = weight;
    } else if (prop === "font-style") {
      style.fontStyle = value.toLowerCase() === "italic" || value.toLowerCase() === "oblique"
        ? "italic"
        : "normal";
    } else if (prop === "font-family") {
      const family = value
        .replace(/[{}<>]/g, "")
        .replace(/monospace/gi, "")
        .replace(/,\s*,/g, ",")
        .replace(/^,|,$/g, "")
        .trim();
      if (family && !UNSAFE_VALUE.test(family)) {
        style.fontFamily = `${family}, ${FONT_FALLBACK}`;
      }
    } else if (prop === "text-align") {
      const align = value.toLowerCase();
      if (align === "center") style.textAlign = "center";
      else if (align === "right" || align === "end") style.textAlign = "right";
      else if (align === "left" || align === "start" || align === "justify") style.textAlign = "left";
      else style.textAlign = "auto";
    } else if (prop === "vertical-align") {
      const align = value.toLowerCase();
      if (align === "top") style.verticalAlign = "top";
      else if (align === "bottom") style.verticalAlign = "bottom";
      else style.verticalAlign = "middle";
    } else if (prop === "white-space") {
      const white = value.toLowerCase();
      style.wrap = white === "normal" || white === "pre-wrap" || white === "pre-line";
    } else if (prop === "border") {
      const border = parseExcelBorder(value);
      style.borderTop = border ? { ...border } : null;
      style.borderRight = border ? { ...border } : null;
      style.borderBottom = border ? { ...border } : null;
      style.borderLeft = border ? { ...border } : null;
    } else if (prop === "border-top") {
      style.borderTop = parseExcelBorder(value);
    } else if (prop === "border-right") {
      style.borderRight = parseExcelBorder(value);
    } else if (prop === "border-bottom") {
      style.borderBottom = parseExcelBorder(value);
    } else if (prop === "border-left") {
      style.borderLeft = parseExcelBorder(value);
    }
  }
}

function styleFromRules(
  rules: Map<string, Decl[]>,
  tag: "td" | "th",
  className: string,
  inline: string
): ExcelCellStyle {
  const style = defaultStyle();
  applyDecls(style, rules.get(tag) ?? []);
  for (const name of className.split(/\s+/)) {
    if (!name) continue;
    applyDecls(style, rules.get(`.${name}`) ?? []);
    applyDecls(style, rules.get(`${tag}.${name}`) ?? []);
  }
  applyDecls(style, parseDecls(inline));
  return style;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(100, Math.floor(n));
}

function widthHint(attrs: Record<string, string>, decls: Decl[]): number | null {
  for (const decl of decls) {
    if (decl.prop === "width") {
      const px = excelLengthToPx(decl.value);
      if (px && px > 0) return roundPx(px);
    }
  }
  const attr = excelLengthToPx(attrs.width);
  return attr && attr > 0 ? roundPx(attr) : null;
}

function heightHint(attrs: Record<string, string>, decls: Decl[]): number | null {
  for (const decl of decls) {
    if (decl.prop === "height") {
      const px = excelLengthToPx(decl.value);
      if (px && px > 0) return roundPx(px);
    }
  }
  const attr = excelLengthToPx(attrs.height);
  return attr && attr > 0 ? roundPx(attr) : null;
}

function excelDocument(raw: string): string {
  const trimmed = raw.replace(/^\uFEFF/, "").replace(/^\s+/, "");
  if (/^Version:/i.test(trimmed)) {
    const htmlAt = trimmed.search(/<html[\s>]/i);
    if (htmlAt >= 0) return trimmed.slice(htmlAt);
    const tableAt = trimmed.search(/<table[\s>]/i);
    if (tableAt >= 0) return trimmed.slice(tableAt);
  }
  return trimmed;
}

function prepareMarkup(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, "")
    .replace(/<object\b[^>]*>[\s\S]*?<\/object>/gi, "")
    .replace(/<embed\b[^>]*>/gi, "")
    .replace(/<link\b[^>]*>/gi, "")
    .replace(/<xml\b[^>]*>[\s\S]*?<\/xml>/gi, "")
    .replace(/<!--\[if[\s\S]*?<!\[endif\]-->/gi, "")
    .replace(/<!\[if[\s\S]*?<!\[endif\]>/gi, "");
}

function stripNestedTables(inner: string): string {
  let current = inner;
  let guard = 0;
  while (guard < 20 && /<table[\s>]/i.test(current)) {
    const nested = scanBlocks(current, "table");
    if (!nested.length) break;
    let next = "";
    let cursor = 0;
    for (const block of nested) {
      next += current.slice(cursor, block.start);
      cursor = block.end;
    }
    next += current.slice(cursor);
    if (next === current) break;
    current = next;
    guard += 1;
  }
  return current;
}

type DraftCell = {
  text: string;
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
  style: ExcelCellStyle;
  widthHint: number | null;
  heightHint: number | null;
};

function chooseTable(html: string): TagBlock | null {
  const tables = scanBlocks(html, "table");
  if (!tables.length) return null;
  let best = tables[0];
  let bestScore = -1;
  for (const table of tables) {
    const score = (table.inner.match(/<t[dh]\b/gi) ?? []).length;
    if (score > bestScore) {
      best = table;
      bestScore = score;
    }
  }
  return best;
}

export function parseExcelClipboardHtml(raw: string): ExcelTableModel {
  if (raw.length > EXCEL_TABLE_MAX_HTML_CHARS) {
    throw new NoticeExcelPasteError(NOTICE_PASTE_TABLE_TOO_LARGE, "too-large");
  }
  const html = excelDocument(raw);
  if (!isExcelClipboardHtml(html)) {
    throw new NoticeExcelPasteError(NOTICE_PASTE_EXCEL_FALLBACK, "not-excel");
  }
  const rules = parseStyleRules(extractStyleText(html));
  const table = chooseTable(prepareMarkup(html));
  if (!table) throw new NoticeExcelPasteError(NOTICE_PASTE_EXCEL_EMPTY, "empty");
  const inner = stripNestedTables(table.inner);
  const colWidths: number[] = [];
  for (const col of scanBlocks(inner, "col")) {
    const attrs = parseAttributes(col.attrSource);
    const hint = widthHint(attrs, parseDecls(attrs.style || ""));
    const span = positiveInt(attrs.span, 1);
    for (let i = 0; i < span; i++) colWidths.push(hint && hint > 0 ? Math.min(hint, 1600) : 0);
    if (colWidths.length > EXCEL_TABLE_MAX_COLS) {
      throw new NoticeExcelPasteError(NOTICE_PASTE_TABLE_TOO_LARGE, "too-large");
    }
  }

  const rowBlocks = scanBlocks(inner, "tr");
  if (!rowBlocks.length || rowBlocks.length > EXCEL_TABLE_MAX_ROWS) {
    if (rowBlocks.length > EXCEL_TABLE_MAX_ROWS) {
      throw new NoticeExcelPasteError(NOTICE_PASTE_TABLE_TOO_LARGE, "too-large");
    }
    throw new NoticeExcelPasteError(NOTICE_PASTE_EXCEL_EMPTY, "empty");
  }

  const occupied: boolean[][] = [];
  const drafts: DraftCell[] = [];
  const rowHeightHints: Array<number | null> = [];
  let cellCount = 0;

  rowBlocks.forEach((rowBlock, rowIndex) => {
    const rowAttrs = parseAttributes(rowBlock.attrSource);
    rowHeightHints[rowIndex] = heightHint(rowAttrs, parseDecls(rowAttrs.style || ""));
    let colIndex = 0;
    const cells = [
      ...scanBlocks(rowBlock.inner, "td"),
      ...scanBlocks(rowBlock.inner, "th"),
    ].sort((a, b) => a.start - b.start);
    for (const cellBlock of cells) {
      while (occupied[rowIndex]?.[colIndex]) colIndex += 1;
      if (colIndex >= EXCEL_TABLE_MAX_COLS) {
        throw new NoticeExcelPasteError(NOTICE_PASTE_TABLE_TOO_LARGE, "too-large");
      }
      const attrs = parseAttributes(cellBlock.attrSource);
      const tag = cellBlock.attrSource.trim().toLowerCase().startsWith("th") ? "th" : "td";
      const inline = attrs.style || "";
      const style = styleFromRules(rules, tag, attrs.class || attrs.classname || "", inline);
      if (!style.background && attrs.bgcolor) style.background = parseExcelColor(attrs.bgcolor);
      if (style.textAlign === "auto" && attrs.align) {
        const align = attrs.align.toLowerCase();
        if (align === "center") style.textAlign = "center";
        else if (align === "right") style.textAlign = "right";
        else if (align === "left") style.textAlign = "left";
      }
      if (attrs.valign) {
        const valign = attrs.valign.toLowerCase();
        if (valign === "top") style.verticalAlign = "top";
        else if (valign === "bottom") style.verticalAlign = "bottom";
        else if (valign === "middle" || valign === "center") style.verticalAlign = "middle";
      }
      const rowSpan = positiveInt(attrs.rowspan, 1);
      const colSpan = positiveInt(attrs.colspan, 1);
      if (rowIndex + rowSpan > EXCEL_TABLE_MAX_ROWS || colIndex + colSpan > EXCEL_TABLE_MAX_COLS) {
        throw new NoticeExcelPasteError(NOTICE_PASTE_TABLE_TOO_LARGE, "too-large");
      }
      cellCount += rowSpan * colSpan;
      if (cellCount > EXCEL_TABLE_MAX_CELLS) {
        throw new NoticeExcelPasteError(NOTICE_PASTE_TABLE_TOO_LARGE, "too-large");
      }
      const inlineDecls = parseDecls(inline);
      drafts.push({
        text: cellText(cellBlock.inner),
        row: rowIndex,
        col: colIndex,
        rowSpan,
        colSpan,
        style,
        widthHint: colSpan === 1 ? widthHint(attrs, inlineDecls) : null,
        heightHint: rowSpan === 1 ? heightHint(attrs, inlineDecls) : null,
      });
      for (let r = 0; r < rowSpan; r++) {
        for (let c = 0; c < colSpan; c++) {
          occupied[rowIndex + r] = occupied[rowIndex + r] ?? [];
          occupied[rowIndex + r][colIndex + c] = true;
        }
      }
      colIndex += colSpan;
    }
  });

  if (!drafts.length) throw new NoticeExcelPasteError(NOTICE_PASTE_EXCEL_EMPTY, "empty");

  let cols = colWidths.length;
  let rows = rowBlocks.length;
  for (const cell of drafts) {
    cols = Math.max(cols, cell.col + cell.colSpan);
    rows = Math.max(rows, cell.row + cell.rowSpan);
  }
  if (rows > EXCEL_TABLE_MAX_ROWS || cols > EXCEL_TABLE_MAX_COLS) {
    throw new NoticeExcelPasteError(NOTICE_PASTE_TABLE_TOO_LARGE, "too-large");
  }

  const widths = Array.from({ length: cols }, (_, index) => colWidths[index] || 0);
  for (const cell of drafts) {
    if (cell.colSpan === 1 && cell.widthHint && widths[cell.col] <= 0) {
      widths[cell.col] = Math.min(cell.widthHint, 1600);
    }
  }
  for (let i = 0; i < widths.length; i++) {
    if (widths[i] <= 0) widths[i] = 72;
    widths[i] = roundPx(Math.max(24, widths[i]));
  }

  const heights = Array.from({ length: rows }, () => 0);
  for (let i = 0; i < rowBlocks.length; i++) {
    if (rowHeightHints[i] && rowHeightHints[i]! > 0) heights[i] = rowHeightHints[i]!;
  }
  for (const cell of drafts) {
    if (cell.rowSpan === 1 && cell.heightHint && heights[cell.row] <= 0) {
      heights[cell.row] = cell.heightHint;
    }
  }
  for (let i = 0; i < heights.length; i++) {
    if (heights[i] <= 0) heights[i] = 20;
    heights[i] = roundPx(Math.max(16, Math.min(heights[i], 600)));
  }

  const cssWidth = widths.reduce((sum, width) => sum + width, 0);
  const cssHeight = heights.reduce((sum, height) => sum + height, 0);
  if (cssWidth > 8000 || cssHeight > 12000) {
    throw new NoticeExcelPasteError(NOTICE_PASTE_TABLE_TOO_LARGE, "too-large");
  }

  return {
    rows,
    cols,
    colWidths: widths,
    rowHeights: heights,
    cells: drafts.map((cell) => ({
      text: cell.text,
      row: cell.row,
      col: cell.col,
      rowSpan: cell.rowSpan,
      colSpan: cell.colSpan,
      style: cell.style,
    })),
  };
}

export function excelTableScale(cssWidth: number, cssHeight: number): number {
  const longEdge = Math.max(cssWidth, cssHeight, 1);
  let scale = 2;
  if (longEdge * scale < EXCEL_TABLE_MIN_LONG_EDGE) {
    scale = Math.min(EXCEL_TABLE_MAX_SCALE, EXCEL_TABLE_MIN_LONG_EDGE / longEdge);
  }
  if (longEdge * scale > EXCEL_TABLE_MAX_LONG_EDGE) {
    scale = EXCEL_TABLE_MAX_LONG_EDGE / longEdge;
  }
  const pixels = cssWidth * scale * cssHeight * scale;
  const maxPixels = EXCEL_TABLE_MAX_LONG_EDGE * EXCEL_TABLE_MAX_LONG_EDGE;
  if (pixels > maxPixels) scale = Math.sqrt(maxPixels / (cssWidth * cssHeight));
  if (!Number.isFinite(scale) || scale < 1) {
    throw new NoticeExcelPasteError(NOTICE_PASTE_TABLE_TOO_LARGE, "too-large");
  }
  return scale;
}

function prefixSums(sizes: number[]): number[] {
  const sums = [0];
  for (const size of sizes) sums.push(sums[sums.length - 1] + size);
  return sums;
}

function canvasFont(style: ExcelCellStyle, sizePx: number): string {
  const italic = style.fontStyle === "italic" ? "italic" : "normal";
  return `${italic} ${style.fontWeight} ${sizePx}px ${style.fontFamily}`;
}

function wrapLine(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, wrap: boolean): string[] {
  if (!wrap) return [text];
  const lines: string[] = [];
  let line = "";
  const tokens = text.split(/(\s+)/).filter((token) => token.length > 0);
  const pieces = tokens.length ? tokens : [""];
  for (const token of pieces) {
    const next = line + token;
    if (line && ctx.measureText(next).width > maxWidth) {
      lines.push(line.replace(/\s+$/g, ""));
      line = token.trimStart();
      if (ctx.measureText(line).width > maxWidth) {
        lines.push(...breakChars(ctx, line, maxWidth));
        line = "";
      }
    } else if (!line && ctx.measureText(token).width > maxWidth) {
      lines.push(...breakChars(ctx, token.trim(), maxWidth));
    } else {
      line = next;
    }
  }
  if (line) lines.push(line.replace(/\s+$/g, ""));
  return lines.length ? lines : [""];
}

function breakChars(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const ch of text) {
    const next = line + ch;
    if (line && ctx.measureText(next).width > maxWidth) {
      lines.push(line);
      line = ch;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

function layoutText(
  ctx: CanvasRenderingContext2D,
  text: string,
  style: ExcelCellStyle,
  maxWidth: number
): string[] {
  const lines: string[] = [];
  for (const paragraph of (text || "").split("\n")) {
    lines.push(...wrapLine(ctx, paragraph, maxWidth, style.wrap));
  }
  return lines.length ? lines : [""];
}

function growRowsForText(
  ctx: CanvasRenderingContext2D,
  model: ExcelTableModel
): number[] {
  const heights = model.rowHeights.slice();
  const xs = prefixSums(model.colWidths);
  for (const cell of model.cells) {
    if (!cell.text) continue;
    const width = Math.max(8, xs[cell.col + cell.colSpan] - xs[cell.col] - 8);
    ctx.font = canvasFont(cell.style, cell.style.fontSizePx);
    const lines = layoutText(ctx, cell.text, cell.style, width);
    const lineHeight = cell.style.fontSizePx * 1.25;
    const needed = lines.length * lineHeight + 4;
    let available = 0;
    for (let i = 0; i < cell.rowSpan; i++) available += heights[cell.row + i] || 0;
    if (needed <= available + 0.5) continue;
    const extra = Math.min(needed - available, 240);
    heights[cell.row + cell.rowSpan - 1] += extra;
  }
  return heights.map((height) => roundPx(height));
}

export function renderExcelTableCanvas(model: ExcelTableModel): HTMLCanvasElement {
  if (typeof document === "undefined") {
    throw new NoticeExcelPasteError(NOTICE_PASTE_EXCEL_FALLBACK, "render");
  }
  const measure = document.createElement("canvas").getContext("2d");
  if (!measure) throw new NoticeExcelPasteError(NOTICE_PASTE_EXCEL_FALLBACK, "render");
  const rowHeights = growRowsForText(measure, model);
  const cssWidth = model.colWidths.reduce((sum, width) => sum + width, 0);
  const cssHeight = rowHeights.reduce((sum, height) => sum + height, 0);
  const scale = excelTableScale(cssWidth, cssHeight);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(cssWidth * scale));
  canvas.height = Math.max(1, Math.round(cssHeight * scale));
  canvas.dataset.excelScale = String(scale);
  canvas.dataset.excelRows = rowHeights.join(",");
  canvas.dataset.excelCols = model.colWidths.join(",");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new NoticeExcelPasteError(NOTICE_PASTE_EXCEL_FALLBACK, "render");
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, cssWidth, cssHeight);

  const xs = prefixSums(model.colWidths);
  const ys = prefixSums(rowHeights);

  for (const cell of model.cells) {
    const x = xs[cell.col];
    const y = ys[cell.row];
    const w = xs[cell.col + cell.colSpan] - x;
    const h = ys[cell.row + cell.rowSpan] - y;
    if (cell.style.background) {
      ctx.fillStyle = cell.style.background;
      ctx.fillRect(x, y, w, h);
    }
  }

  for (const cell of model.cells) {
    const x = xs[cell.col];
    const y = ys[cell.row];
    const w = xs[cell.col + cell.colSpan] - x;
    const h = ys[cell.row + cell.rowSpan] - y;
    if (!cell.text) continue;
    const padX = 4;
    const padY = 2;
    const maxWidth = Math.max(4, w - padX * 2);
    ctx.font = canvasFont(cell.style, cell.style.fontSizePx);
    ctx.fillStyle = cell.style.color;
    const lines = layoutText(ctx, cell.text, cell.style, maxWidth);
    const lineHeight = cell.style.fontSizePx * 1.25;
    const blockHeight = lines.length * lineHeight;
    let textY = y + padY;
    if (cell.style.verticalAlign === "middle") textY = y + Math.max(padY, (h - blockHeight) / 2);
    else if (cell.style.verticalAlign === "bottom") textY = y + Math.max(padY, h - padY - blockHeight);
    const align = resolveExcelTextAlign(cell.style.textAlign, cell.text);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x + 1, y + 1, Math.max(1, w - 2), Math.max(1, h - 2));
    ctx.clip();
    ctx.textBaseline = "top";
    lines.forEach((line, index) => {
      const lineY = textY + index * lineHeight;
      let lineX = x + padX;
      if (align === "center") {
        lineX = x + w / 2;
        ctx.textAlign = "center";
      } else if (align === "right") {
        lineX = x + w - padX;
        ctx.textAlign = "right";
      } else {
        ctx.textAlign = "left";
      }
      ctx.fillText(line, lineX, lineY);
    });
    ctx.restore();
  }

  for (const cell of model.cells) {
    const x = xs[cell.col];
    const y = ys[cell.row];
    const w = xs[cell.col + cell.colSpan] - x;
    const h = ys[cell.row + cell.rowSpan] - y;
    strokeBorder(ctx, cell.style.borderTop, x, y, x + w, y, scale);
    strokeBorder(ctx, cell.style.borderRight, x + w, y, x + w, y + h, scale);
    strokeBorder(ctx, cell.style.borderBottom, x, y + h, x + w, y + h, scale);
    strokeBorder(ctx, cell.style.borderLeft, x, y, x, y + h, scale);
  }

  return canvas;
}

function strokeBorder(
  ctx: CanvasRenderingContext2D,
  border: ExcelBorder | null,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  scale: number
) {
  if (!border) return;
  ctx.save();
  ctx.strokeStyle = border.color;
  ctx.lineWidth = Math.max(border.widthPx, 1 / scale);
  ctx.setLineDash(border.dashed ? [3, 2] : []);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.restore();
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob || blob.size <= 0) {
        reject(new NoticeExcelPasteError(NOTICE_PASTE_EXCEL_FALLBACK, "render"));
        return;
      }
      resolve(blob);
    }, "image/png");
  });
}

export async function renderExcelTablePng(model: ExcelTableModel): Promise<Blob> {
  if (typeof document !== "undefined" && document.fonts?.ready) {
    await document.fonts.ready.catch(() => undefined);
  }
  return canvasToPng(renderExcelTableCanvas(model));
}

export async function excelClipboardHtmlToNoticePhoto(html: string): Promise<File> {
  const model = parseExcelClipboardHtml(html);
  const blob = await renderExcelTablePng(model);
  return new File([blob], `excel-table-${model.rows}x${model.cols}.png`, {
    type: "image/png",
  });
}
