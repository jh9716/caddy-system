#!/usr/bin/env node
/**
 * Build VERTHILL PWA icons, badge, and ivory splash from the official gold monogram.
 * Does not reuse hero-green.jpg. Does not draw the ivory-V mark.
 */
const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");

const ROOT = path.join(__dirname, "..");
const OUT_ICONS = path.join(ROOT, "public", "icons");
const OUT_BRAND = path.join(ROOT, "public", "brand");
const APP = path.join(ROOT, "src", "app");

const OFFICIAL_MONOGRAM =
  "/tmp/verthill-official/verthill_bi2.jpg";
const OFFICIAL_COURSE = "/tmp/verthill-official/intro_img03.jpg";
const MONOGRAM_PATH = path.join(OUT_BRAND, "verthill-monogram.png");
const COURSE_PATH = path.join(OUT_BRAND, "splash-course.jpg");

const GREEN = { r: 0x16, g: 0x30, b: 0x28, alpha: 1 };
const IVORY = { r: 0xf6, g: 0xf1, b: 0xe8, alpha: 1 };

async function extractGoldMonogram(src) {
  const img = sharp(src).ensureAlpha();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;
    const nearWhite = luma > 200 && Math.abs(r - g) < 28 && Math.abs(g - b) < 28;
    const gold = r > 130 && g > 85 && b < 170 && r + 8 >= g && g > b + 8;
    if (nearWhite || !gold) {
      data[i + 3] = 0;
    } else {
      data[i + 3] = 255;
    }
  }
  return sharp(data, {
    raw: { width: info.width, height: info.height, channels: 4 },
  })
    .trim()
    .png();
}

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

async function iconOnGreen(monogramBuf, size, { rounded, pad }) {
  const inner = Math.round(size * (1 - pad * 2));
  const resized = await sharp(monogramBuf)
    .resize(inner, inner, { fit: "inside", withoutEnlargement: false })
    .png()
    .toBuffer();
  const meta = await sharp(resized).metadata();
  const left = Math.round((size - (meta.width || inner)) / 2);
  const top = Math.round((size - (meta.height || inner)) / 2);
  let canvas = sharp({
    create: { width: size, height: size, channels: 4, background: GREEN },
  }).composite([{ input: resized, left, top }]);
  if (rounded) {
    const buf = await canvas.png().toBuffer();
    canvas = sharp(buf).composite([
      { input: roundedMask(size, Math.round(size * 0.22)), blend: "dest-in" },
    ]);
  }
  return canvas.png({ compressionLevel: 9 });
}

async function buildSplash(monogramBuf) {
  const W = 1290;
  const H = 2796;
  const courseH = Math.round(H * 0.48);
  const courseTop = H - courseH;
  const course = await sharp(COURSE_PATH)
    .resize(W, courseH, { fit: "cover", position: "centre" })
    .jpeg({ quality: 86 })
    .toBuffer();

  const markW = 300;
  const mark = await sharp(monogramBuf)
    .resize(markW, Math.round(markW * 0.72), { fit: "inside" })
    .png()
    .toBuffer();
  const markMeta = await sharp(mark).metadata();
  const markX = Math.round((W - (markMeta.width || markW)) / 2);
  const markY = 560;

  const fadeH = Math.round(courseH * 0.38);
  const overlay = Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#f6f1e8" stop-opacity="1"/>
        <stop offset="1" stop-color="#f6f1e8" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <rect x="0" y="0" width="${W}" height="${courseTop}" fill="#f6f1e8"/>
    <rect x="0" y="${courseTop}" width="${W}" height="${fadeH}" fill="url(#fade)"/>
    <text x="50%" y="980" text-anchor="middle" fill="#163028"
      font-size="92" font-family="Times New Roman, serif" letter-spacing="12">VERTHILL</text>
    <text x="50%" y="1064" text-anchor="middle" fill="#8a6e3d"
      font-size="34" font-family="Georgia, serif" letter-spacing="7">Caddy System</text>
    <text x="50%" y="1128" text-anchor="middle" fill="#7b7568"
      font-size="18" font-family="Georgia, serif" letter-spacing="4">Premium Golf Operations</text>
  </svg>`);

  const out = path.join(OUT_BRAND, "splash-portrait.jpg");
  await sharp({
    create: { width: W, height: H, channels: 3, background: IVORY },
  })
    .composite([
      { input: course, top: courseTop, left: 0 },
      { input: overlay, top: 0, left: 0 },
      { input: mark, top: markY, left: markX },
    ])
    .jpeg({ quality: 86, mozjpeg: true })
    .toFile(out);
  console.log("wrote", path.relative(ROOT, out), fs.statSync(out).size);
}

async function main() {
  fs.mkdirSync(OUT_ICONS, { recursive: true });
  fs.mkdirSync(OUT_BRAND, { recursive: true });

  if (fs.existsSync(OFFICIAL_MONOGRAM)) {
    await writePng(MONOGRAM_PATH, await extractGoldMonogram(OFFICIAL_MONOGRAM));
  } else if (!fs.existsSync(MONOGRAM_PATH)) {
    throw new Error("missing official monogram source and public/brand/verthill-monogram.png");
  }

  if (fs.existsSync(OFFICIAL_COURSE)) {
    await sharp(OFFICIAL_COURSE)
      .resize(1920, 1080, { fit: "cover", position: "centre" })
      .jpeg({ quality: 82, mozjpeg: true })
      .toFile(COURSE_PATH);
    console.log("wrote", path.relative(ROOT, COURSE_PATH), fs.statSync(COURSE_PATH).size);
  } else if (!fs.existsSync(COURSE_PATH)) {
    throw new Error("missing splash course photo");
  }

  const monogramBuf = fs.readFileSync(MONOGRAM_PATH);

  const iconMaster = await iconOnGreen(monogramBuf, 1024, { rounded: false, pad: 0.22 });
  await writePng(path.join(OUT_BRAND, "app-icon-master.png"), iconMaster);

  const badgeMaster = await iconOnGreen(monogramBuf, 512, { rounded: false, pad: 0.16 });
  await writePng(path.join(OUT_BRAND, "badge-master.png"), badgeMaster);

  await writePng(
    path.join(OUT_ICONS, "icon-192.png"),
    await iconOnGreen(monogramBuf, 192, { rounded: true, pad: 0.22 })
  );
  await writePng(
    path.join(OUT_ICONS, "icon-512.png"),
    await iconOnGreen(monogramBuf, 512, { rounded: true, pad: 0.22 })
  );
  await writePng(
    path.join(OUT_ICONS, "icon-192-maskable.png"),
    await iconOnGreen(monogramBuf, 192, { rounded: false, pad: 0.28 })
  );
  await writePng(
    path.join(OUT_ICONS, "icon-512-maskable.png"),
    await iconOnGreen(monogramBuf, 512, { rounded: false, pad: 0.28 })
  );
  await writePng(
    path.join(OUT_ICONS, "apple-touch-icon.png"),
    await iconOnGreen(monogramBuf, 180, { rounded: false, pad: 0.2 })
  );
  await writePng(
    path.join(APP, "icon.png"),
    await iconOnGreen(monogramBuf, 192, { rounded: true, pad: 0.22 })
  );
  await writePng(
    path.join(OUT_ICONS, "badge-96.png"),
    await iconOnGreen(monogramBuf, 96, { rounded: false, pad: 0.14 })
  );

  const fav = await (
    await iconOnGreen(monogramBuf, 32, { rounded: true, pad: 0.16 })
  ).toBuffer();
  await writeIco(path.join(APP, "favicon.ico"), fav, 32);
  await writeIco(path.join(ROOT, "public", "favicon.ico"), fav, 32);

  await buildSplash(monogramBuf);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
