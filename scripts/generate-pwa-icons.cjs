#!/usr/bin/env node
/**
 * Generate in-repo VERTHILL PWA icons (no external image URLs).
 * Uses sharp if present (Next optional dep); otherwise a zlib PNG writer.
 */
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "public", "icons");
const APP = path.join(ROOT, "src", "app");

const BG = { r: 0x16, g: 0x30, b: 0x28, a: 255 };
const IVORY = { r: 0xf7, g: 0xf4, b: 0xec, a: 255 };
const GOLD = { r: 0xc4, g: 0xa5, b: 0x74, a: 255 };

function blend(dst, src) {
  const a = src.a / 255;
  if (a <= 0) return dst;
  if (a >= 1) return { ...src };
  return {
    r: Math.round(src.r * a + dst.r * (1 - a)),
    g: Math.round(src.g * a + dst.g * (1 - a)),
    b: Math.round(src.b * a + dst.b * (1 - a)),
    a: 255,
  };
}

function cover(px, x, y, color) {
  const i = (y * px.size + x) * 4;
  const dst = {
    r: px.data[i],
    g: px.data[i + 1],
    b: px.data[i + 2],
    a: px.data[i + 3],
  };
  const out = blend(dst, color);
  px.data[i] = out.r;
  px.data[i + 1] = out.g;
  px.data[i + 2] = out.b;
  px.data[i + 3] = out.a;
}

function fillRect(px, x0, y0, x1, y1, color) {
  const xMin = Math.max(0, Math.floor(x0));
  const yMin = Math.max(0, Math.floor(y0));
  const xMax = Math.min(px.size - 1, Math.ceil(x1));
  const yMax = Math.min(px.size - 1, Math.ceil(y1));
  for (let y = yMin; y <= yMax; y++) {
    for (let x = xMin; x <= xMax; x++) cover(px, x, y, color);
  }
}

function fillRoundedRect(px, x0, y0, x1, y1, radius, color) {
  const r = Math.max(0, radius);
  for (let y = Math.floor(y0); y <= Math.ceil(y1); y++) {
    for (let x = Math.floor(x0); x <= Math.ceil(x1); x++) {
      if (x < 0 || y < 0 || x >= px.size || y >= px.size) continue;
      const cx = Math.min(Math.abs(x - x0), Math.abs(x1 - x));
      const cy = Math.min(Math.abs(y - y0), Math.abs(y1 - y));
      let inside = true;
      if (cx < r && cy < r) {
        const dx = r - cx;
        const dy = r - cy;
        inside = dx * dx + dy * dy <= r * r;
      }
      if (inside && x >= x0 && x <= x1 && y >= y0 && y <= y1) {
        cover(px, x, y, color);
      }
    }
  }
}

function strokeLine(px, x0, y0, x1, y1, width, color) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const hw = width / 2;
  const steps = Math.ceil(len);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const cx = x0 + dx * t;
    const cy = y0 + dy * t;
    for (let oy = -hw - 1; oy <= hw + 1; oy++) {
      for (let ox = -hw - 1; ox <= hw + 1; ox++) {
        const pxX = Math.round(cx + ox);
        const pxY = Math.round(cy + oy);
        if (pxX < 0 || pxY < 0 || pxX >= px.size || pxY >= px.size) continue;
        const along = ((pxX - cx) * nx + (pxY - cy) * ny);
        const dist = Math.abs(along);
        if (dist <= hw) {
          const a = dist > hw - 1 ? Math.round(255 * (hw - dist)) : 255;
          cover(px, pxX, pxY, { ...color, a: Math.min(color.a, Math.max(0, a)) });
        }
      }
    }
  }
}

function drawMonogram(px, inset) {
  const s = px.size;
  const left = s * inset;
  const right = s * (1 - inset);
  const top = s * (inset + 0.06);
  const bottom = s * (1 - inset - 0.14);
  const midX = s / 2;
  const stroke = Math.max(8, s * 0.11);
  strokeLine(px, left + s * 0.04, top, midX, bottom, stroke, IVORY);
  strokeLine(px, right - s * 0.04, top, midX, bottom, stroke, IVORY);
  const barY0 = s * (1 - inset - 0.08);
  const barY1 = barY0 + Math.max(4, s * 0.025);
  fillRect(px, s * 0.38, barY0, s * 0.62, barY1, GOLD);
}

function makeCanvas(size, { rounded, maskable }) {
  const data = Buffer.alloc(size * size * 4);
  const px = { size, data };
  if (rounded) {
    data.fill(0);
    const radius = size * 0.22;
    fillRoundedRect(px, 0, 0, size - 1, size - 1, radius, BG);
    drawMonogram(px, 0.18);
  } else {
    for (let i = 0; i < data.length; i += 4) {
      data[i] = BG.r;
      data[i + 1] = BG.g;
      data[i + 2] = BG.b;
      data[i + 3] = 255;
    }
    drawMonogram(px, maskable ? 0.22 : 0.16);
  }
  return px;
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return ~c >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(px) {
  const { size, data } = px;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    data.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const compressed = zlib.deflateSync(raw, { level: 9 });
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function writePng(relOrAbs, px) {
  const abs = path.isAbsolute(relOrAbs) ? relOrAbs : path.join(ROOT, relOrAbs);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, encodePng(px));
  console.log("wrote", path.relative(ROOT, abs), px.size);
}

function writeIco(abs, px) {
  const png = encodePng(px);
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry[0] = px.size >= 256 ? 0 : px.size;
  entry[1] = px.size >= 256 ? 0 : px.size;
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(22, 12);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, Buffer.concat([header, entry, png]));
  console.log("wrote", path.relative(ROOT, abs), "ico");
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  writePng(path.join(OUT, "icon-192.png"), makeCanvas(192, { rounded: true, maskable: false }));
  writePng(path.join(OUT, "icon-512.png"), makeCanvas(512, { rounded: true, maskable: false }));
  writePng(
    path.join(OUT, "icon-192-maskable.png"),
    makeCanvas(192, { rounded: false, maskable: true })
  );
  writePng(
    path.join(OUT, "icon-512-maskable.png"),
    makeCanvas(512, { rounded: false, maskable: true })
  );
  writePng(
    path.join(OUT, "apple-touch-icon.png"),
    makeCanvas(180, { rounded: false, maskable: false })
  );
  writePng(path.join(APP, "icon.png"), makeCanvas(192, { rounded: true, maskable: false }));
  const favPx = makeCanvas(32, { rounded: true, maskable: false });
  writeIco(path.join(APP, "favicon.ico"), favPx);
  writeIco(path.join(ROOT, "public", "favicon.ico"), favPx);
}

main();
