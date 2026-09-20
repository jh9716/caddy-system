#!/usr/bin/env node
/**
 * Build VERTHILL PWA icons, notification badge, and splash from brand masters.
 * Uses sharp. Regenerates public/icons, favicons, and public/brand/splash-portrait.jpg.
 *
 * Source PNGs (one-shot import): /opt/cursor/artifacts/assets/verthill-*.png
 * After first run, masters live in public/brand/ and generate-pwa-icons.cjs can resize them.
 */
const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");

const ROOT = path.join(__dirname, "..");
const SRC_ICON_IMPORT = "/opt/cursor/artifacts/assets/verthill-app-icon.png";
const SRC_BADGE_IMPORT = "/opt/cursor/artifacts/assets/verthill-notification-badge.png";
const SRC_ICON_MASTER = path.join(ROOT, "public", "brand", "app-icon-master.png");
const SRC_BADGE_MASTER = path.join(ROOT, "public", "brand", "badge-master.png");
const HERO = path.join(ROOT, "public", "brand", "hero-green.jpg");
const OUT_ICONS = path.join(ROOT, "public", "icons");
const OUT_BRAND = path.join(ROOT, "public", "brand");
const APP = path.join(ROOT, "src", "app");

const FALLBACK_BG = { r: 0x16, g: 0x30, b: 0x28, alpha: 1 };

function isMarkPixel(r, g, b, a) {
  if (a < 24) return false;
  const luma = 0.299 * r + 0.587 * g + 0.114 * b;
  const ivory = luma > 165 && Math.abs(r - g) < 45 && b > 140;
  const gold = r > 140 && g > 105 && b < 150 && r >= g - 10;
  return ivory || gold;
}

async function flattenNearBlackToGreen(inputPath) {
  const img = sharp(inputPath).ensureAlpha();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const sampleX = Math.floor(width / 2);
  const sampleY = Math.max(8, Math.floor(height * 0.1));
  const si = (sampleY * width + sampleX) * 4;
  const bg = { r: data[si], g: data[si + 1], b: data[si + 2], alpha: 1 };
  if (Math.max(bg.r, bg.g, bg.b) < 28) Object.assign(bg, FALLBACK_BG);

  const seen = Buffer.alloc(width * height);
  const stack = [0, width - 1, (height - 1) * width, height * width - 1];
  while (stack.length) {
    const idx = stack.pop();
    if (idx < 0 || idx >= width * height || seen[idx]) continue;
    seen[idx] = 1;
    const i = idx * 4;
    if (isMarkPixel(data[i], data[i + 1], data[i + 2], data[i + 3])) continue;
    data[i] = bg.r;
    data[i + 1] = bg.g;
    data[i + 2] = bg.b;
    data[i + 3] = 255;
    const x = idx % width;
    const y = (idx - x) / width;
    if (x > 0) stack.push(idx - 1);
    if (x + 1 < width) stack.push(idx + 1);
    if (y > 0) stack.push(idx - width);
    if (y + 1 < height) stack.push(idx + width);
  }

  flattenNearBlackToGreen.lastBg = bg;
  return sharp(data, {
    raw: { width, height, channels: 4 },
  });
}

function roundedMask(size, radius) {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
      <rect width="${size}" height="${size}" rx="${radius}" ry="${radius}" fill="#fff"/>
    </svg>`
  );
}

async function squarePng(pipeline, size, { rounded = false } = {}) {
  let img = pipeline.clone().resize(size, size, { fit: "cover", position: "centre" });
  if (rounded) {
    const buf = await img.png().toBuffer();
    img = sharp(buf).composite([
      { input: roundedMask(size, Math.round(size * 0.22)), blend: "dest-in" },
    ]);
  }
  return img.png({ compressionLevel: 9 });
}

async function writePng(abs, pipeline) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  await pipeline.toFile(abs);
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

async function paddedMaskable(master, size, bg) {
  const inner = Math.round(size * 0.62);
  const innerBuf = await master.clone().resize(inner, inner, { fit: "cover" }).png().toBuffer();
  return sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: bg.r, g: bg.g, b: bg.b, alpha: 1 },
    },
  }).composite([
    {
      input: innerBuf,
      top: Math.round((size - inner) / 2),
      left: Math.round((size - inner) / 2),
    },
  ]);
}

async function buildSplash(iconMaster) {
  const W = 1290;
  const H = 2796;
  const hero = await sharp(HERO)
    .resize(W, H, { fit: "cover", position: "north" })
    .modulate({ brightness: 0.88, saturation: 0.88 })
    .toBuffer();

  const markSize = 168;
  const mark = await (await squarePng(iconMaster, markSize, { rounded: true })).toBuffer();

  const overlay = Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#08120e" stop-opacity="0.58"/>
        <stop offset="0.4" stop-color="#0c1c14" stop-opacity="0.22"/>
        <stop offset="1" stop-color="#08120e" stop-opacity="0.7"/>
      </linearGradient>
    </defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
    <text x="50%" y="920" text-anchor="middle" fill="#f7f4ec"
      font-size="96" font-family="Times New Roman, serif" letter-spacing="14">VERTHILL</text>
    <text x="50%" y="1008" text-anchor="middle" fill="#e9dcc8"
      font-size="38" font-family="Georgia, serif" letter-spacing="6">Caddy System</text>
  </svg>`);

  const out = path.join(OUT_BRAND, "splash-portrait.jpg");
  await sharp(hero)
    .composite([
      { input: overlay, top: 0, left: 0 },
      { input: mark, top: 660, left: Math.round((W - markSize) / 2) },
    ])
    .jpeg({ quality: 84, mozjpeg: true })
    .toFile(out);
  console.log("wrote", path.relative(ROOT, out), fs.statSync(out).size);
}

async function main() {
  const SRC_ICON = fs.existsSync(SRC_ICON_IMPORT) ? SRC_ICON_IMPORT : SRC_ICON_MASTER;
  const SRC_BADGE = fs.existsSync(SRC_BADGE_IMPORT) ? SRC_BADGE_IMPORT : SRC_BADGE_MASTER;
  if (!fs.existsSync(SRC_ICON) || !fs.existsSync(SRC_BADGE)) {
    throw new Error("brand source PNGs missing (app-icon-master / badge-master)");
  }
  fs.mkdirSync(OUT_ICONS, { recursive: true });
  fs.mkdirSync(OUT_BRAND, { recursive: true });

  const iconMaster = await flattenNearBlackToGreen(SRC_ICON);
  const iconBg = flattenNearBlackToGreen.lastBg || FALLBACK_BG;
  const badgeMaster = await flattenNearBlackToGreen(SRC_BADGE);

  await writePng(
    path.join(OUT_BRAND, "app-icon-master.png"),
    iconMaster.clone().resize(1024, 1024).png({ compressionLevel: 9 })
  );
  await writePng(
    path.join(OUT_BRAND, "badge-master.png"),
    badgeMaster.clone().resize(512, 512).png({ compressionLevel: 9 })
  );

  await writePng(path.join(OUT_ICONS, "icon-192.png"), await squarePng(iconMaster, 192, { rounded: true }));
  await writePng(path.join(OUT_ICONS, "icon-512.png"), await squarePng(iconMaster, 512, { rounded: true }));
  await writePng(
    path.join(OUT_ICONS, "icon-192-maskable.png"),
    await paddedMaskable(iconMaster, 192, iconBg)
  );
  await writePng(
    path.join(OUT_ICONS, "icon-512-maskable.png"),
    await paddedMaskable(iconMaster, 512, iconBg)
  );
  await writePng(
    path.join(OUT_ICONS, "apple-touch-icon.png"),
    await squarePng(iconMaster, 180, { rounded: false })
  );
  await writePng(path.join(APP, "icon.png"), await squarePng(iconMaster, 192, { rounded: true }));
  await writePng(path.join(OUT_ICONS, "badge-96.png"), await squarePng(badgeMaster, 96, { rounded: false }));

  const favPx = await (await squarePng(iconMaster, 32, { rounded: true })).toBuffer();
  await writeIco(path.join(APP, "favicon.ico"), favPx, 32);
  await writeIco(path.join(ROOT, "public", "favicon.ico"), favPx, 32);

  await buildSplash(iconMaster);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
