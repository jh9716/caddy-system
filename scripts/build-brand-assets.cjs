#!/usr/bin/env node
/**
 * Build VERTHILL PWA icons, badge, and splash from the approved
 * source-app-icon.png / source-splash.png designs.
 * Does not reuse hero-green.jpg. Does not draw the ivory-V mark.
 */
const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");

const ROOT = path.join(__dirname, "..");
const OUT_ICONS = path.join(ROOT, "public", "icons");
const OUT_BRAND = path.join(ROOT, "public", "brand");
const APP = path.join(ROOT, "src", "app");

const SOURCE_ICON = path.join(OUT_BRAND, "source-app-icon.png");
const SOURCE_SPLASH = path.join(OUT_BRAND, "source-splash.png");
const MONOGRAM_PATH = path.join(OUT_BRAND, "verthill-monogram.png");
const COURSE_PATH = path.join(OUT_BRAND, "splash-course.jpg");

function roundedMask(size, radius) {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
      <rect width="${size}" height="${size}" rx="${radius}" ry="${radius}" fill="#fff"/>
    </svg>`
  );
}

async function writePng(abs, pipeline) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  await pipeline.png({ compressionLevel: 9 }).toFile(abs);
  console.log("wrote", path.relative(ROOT, abs), fs.statSync(abs).size);
}

async function writeIco(abs, pngBuf, size) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry[0] = size >= 256 ? 0 : size;
  entry[1] = size >= 256 ? 0 : size;
  entry.writeUInt32LE(pngBuf.length, 8);
  entry.writeUInt32LE(22, 12);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, Buffer.concat([header, entry, pngBuf]));
  console.log("wrote", path.relative(ROOT, abs), "ico");
}

/** Crop the iOS mockup, then fill leftover white corner wedges with nearby green. */
async function squareGreenIcon(srcPath) {
  const { data, info } = await sharp(srcPath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;
  let minX = w;
  let minY = h;
  let maxX = 0;
  let maxY = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const r = data[p];
      const g = data[p + 1];
      const b = data[p + 2];
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      const nearWhite = luma > 210 && Math.abs(r - g) < 24 && Math.abs(g - b) < 24;
      if (nearWhite) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  const cropped = await sharp(srcPath)
    .extract({
      left: minX,
      top: minY,
      width: maxX - minX + 1,
      height: maxY - minY + 1,
    })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const cw = cropped.info.width;
  const ch = cropped.info.height;
  const cd = cropped.data;
  const ins = Math.round(Math.min(cw, ch) * 0.08);
  const sp = (ins * cw + ins) * 4;
  const fill = { r: cd[sp], g: cd[sp + 1], b: cd[sp + 2] };

  const vis = new Uint8Array(cw * ch);
  const q = [];
  const push = (x, y) => {
    if (x < 0 || y < 0 || x >= cw || y >= ch) return;
    const idx = y * cw + x;
    if (vis[idx]) return;
    const p = idx * 4;
    const r = cd[p];
    const g = cd[p + 1];
    const b = cd[p + 2];
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;
    const nearWhite = luma > 200 && Math.abs(r - g) < 28 && Math.abs(g - b) < 28;
    if (!nearWhite) return;
    vis[idx] = 1;
    cd[p] = fill.r;
    cd[p + 1] = fill.g;
    cd[p + 2] = fill.b;
    cd[p + 3] = 255;
    q.push(x, y);
  };
  push(0, 0);
  push(cw - 1, 0);
  push(0, ch - 1);
  push(cw - 1, ch - 1);
  for (let i = 0; i < q.length; i += 2) {
    push(q[i] + 1, q[i + 1]);
    push(q[i] - 1, q[i + 1]);
    push(q[i], q[i + 1] + 1);
    push(q[i], q[i + 1] - 1);
  }

  const buf = await sharp(cd, {
    raw: { width: cw, height: ch, channels: 4 },
  })
    .resize(1024, 1024, { fit: "cover", position: "centre" })
    .png({ compressionLevel: 9 })
    .toBuffer();
  return { buf, green: fill };
}

async function extractMonogram(squareBuf) {
  const { data, info } = await sharp(squareBuf)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const gold =
      r > 118 &&
      g > 72 &&
      b < 190 &&
      r + 28 >= g &&
      g > b + 12 &&
      r + g > b * 2.05;
    data[i + 3] = gold ? 255 : 0;
  }
  return sharp(data, {
    raw: { width: info.width, height: info.height, channels: 4 },
  })
    .trim()
    .png()
    .toBuffer();
}

async function resizeSquare(srcBuf, size, { rounded, pad }) {
  const inner = Math.max(1, Math.round(size * (1 - pad * 2)));
  const placed = await sharp(srcBuf)
    .resize(inner, inner, { fit: "cover", position: "centre" })
    .png()
    .toBuffer();
  const bg = await sharp(srcBuf).extract({ left: 8, top: 8, width: 8, height: 8 }).raw().toBuffer();
  const background = { r: bg[0], g: bg[1], b: bg[2], alpha: 1 };
  const left = Math.round((size - inner) / 2);
  const top = Math.round((size - inner) / 2);
  let canvas = sharp({
    create: { width: size, height: size, channels: 4, background },
  }).composite([{ input: placed, left, top }]);
  if (rounded) {
    const buf = await canvas.png().toBuffer();
    canvas = sharp(buf).composite([
      { input: roundedMask(size, Math.round(size * 0.22)), blend: "dest-in" },
    ]);
  }
  return canvas.png({ compressionLevel: 9 });
}

async function badgeFromMonogram(monogramBuf, size) {
  const inner = Math.round(size * 0.72);
  const resized = await sharp(monogramBuf)
    .resize(inner, inner, { fit: "inside" })
    .png()
    .toBuffer();
  const meta = await sharp(resized).metadata();
  const left = Math.round((size - (meta.width || inner)) / 2);
  const top = Math.round((size - (meta.height || inner)) / 2);
  return sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: 0x16, g: 0x30, b: 0x28, alpha: 1 },
    },
  })
    .composite([{ input: resized, left, top }])
    .png({ compressionLevel: 9 });
}

async function buildSplash() {
  const W = 1290;
  const H = 2796;
  const out = path.join(OUT_BRAND, "splash-portrait.jpg");
  await sharp(SOURCE_SPLASH)
    .resize(W, H, { fit: "cover", position: "centre" })
    .jpeg({ quality: 90, mozjpeg: true })
    .toFile(out);
  console.log("wrote", path.relative(ROOT, out), fs.statSync(out).size);

  const srcMeta = await sharp(SOURCE_SPLASH).metadata();
  const sw = srcMeta.width || 941;
  const sh = srcMeta.height || 1672;
  const courseTop = Math.round(sh * 0.48);
  const courseH = Math.round(sh * 0.44);
  await sharp(SOURCE_SPLASH)
    .extract({
      left: 0,
      top: courseTop,
      width: sw,
      height: Math.min(courseH, sh - courseTop),
    })
    .resize(1920, 1080, { fit: "cover", position: "centre" })
    .jpeg({ quality: 86, mozjpeg: true })
    .toFile(COURSE_PATH);
  console.log("wrote", path.relative(ROOT, COURSE_PATH), fs.statSync(COURSE_PATH).size);
}

async function main() {
  if (!fs.existsSync(SOURCE_ICON)) throw new Error("missing public/brand/source-app-icon.png");
  if (!fs.existsSync(SOURCE_SPLASH)) throw new Error("missing public/brand/source-splash.png");

  fs.mkdirSync(OUT_ICONS, { recursive: true });
  fs.mkdirSync(OUT_BRAND, { recursive: true });

  const squared = await squareGreenIcon(SOURCE_ICON);
  const master1024 = squared.buf;
  fs.writeFileSync(path.join(OUT_BRAND, "app-icon-master.png"), master1024);
  console.log("wrote public/brand/app-icon-master.png", master1024.length);

  const monogramBuf = await extractMonogram(master1024);
  fs.writeFileSync(MONOGRAM_PATH, monogramBuf);
  console.log("wrote", path.relative(ROOT, MONOGRAM_PATH), monogramBuf.length);

  const badgeMaster = await badgeFromMonogram(monogramBuf, 512);
  await writePng(path.join(OUT_BRAND, "badge-master.png"), badgeMaster);

  await writePng(
    path.join(OUT_ICONS, "icon-192.png"),
    await resizeSquare(master1024, 192, { rounded: true, pad: 0 })
  );
  await writePng(
    path.join(OUT_ICONS, "icon-512.png"),
    await resizeSquare(master1024, 512, { rounded: true, pad: 0 })
  );
  await writePng(
    path.join(OUT_ICONS, "icon-192-maskable.png"),
    await badgeFromMonogram(monogramBuf, 192)
  );
  await writePng(
    path.join(OUT_ICONS, "icon-512-maskable.png"),
    await badgeFromMonogram(monogramBuf, 512)
  );
  await writePng(
    path.join(OUT_ICONS, "apple-touch-icon.png"),
    await resizeSquare(master1024, 180, { rounded: false, pad: 0 })
  );
  await writePng(
    path.join(APP, "icon.png"),
    await resizeSquare(master1024, 192, { rounded: true, pad: 0 })
  );
  await writePng(path.join(OUT_ICONS, "badge-96.png"), await badgeFromMonogram(monogramBuf, 96));

  const fav = await (
    await resizeSquare(master1024, 32, { rounded: true, pad: 0 })
  ).toBuffer();
  await writeIco(path.join(APP, "favicon.ico"), fav, 32);
  await writeIco(path.join(ROOT, "public", "favicon.ico"), fav, 32);

  await buildSplash();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
