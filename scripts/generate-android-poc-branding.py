#!/usr/bin/env python3
"""Resize approved VERTHILL branding into Android mipmap/splash slots. No new artwork."""

from __future__ import annotations

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
RES = ROOT / "android" / "app" / "src" / "main" / "res"
ICON_SRC = ROOT / "public" / "icons" / "icon-512.png"
MASKABLE_SRC = ROOT / "public" / "icons" / "icon-512-maskable.png"
SPLASH_SRC = ROOT / "public" / "brand" / "splash-portrait.jpg"

LAUNCHER = {
    "mipmap-mdpi": 48,
    "mipmap-hdpi": 72,
    "mipmap-xhdpi": 96,
    "mipmap-xxhdpi": 144,
    "mipmap-xxxhdpi": 192,
}
FOREGROUND = {
    "mipmap-mdpi": 108,
    "mipmap-hdpi": 162,
    "mipmap-xhdpi": 216,
    "mipmap-xxhdpi": 324,
    "mipmap-xxxhdpi": 432,
}
SPLASH = {
    "drawable-port-mdpi": (320, 480),
    "drawable-port-hdpi": (480, 800),
    "drawable-port-xhdpi": (720, 1280),
    "drawable-port-xxhdpi": (1080, 1920),
    "drawable-port-xxxhdpi": (1440, 2560),
    "drawable-land-mdpi": (480, 320),
    "drawable-land-hdpi": (800, 480),
    "drawable-land-xhdpi": (1280, 720),
    "drawable-land-xxhdpi": (1920, 1080),
    "drawable-land-xxxhdpi": (2560, 1440),
}


def cover(src: Image.Image, size: tuple[int, int]) -> Image.Image:
    out_w, out_h = size
    scale = max(out_w / src.width, out_h / src.height)
    resized = src.resize(
        (max(1, round(src.width * scale)), max(1, round(src.height * scale))),
        Image.Resampling.LANCZOS,
    )
    left = (resized.width - out_w) // 2
    top = (resized.height - out_h) // 2
    return resized.crop((left, top, left + out_w, top + out_h))


def save_png(img: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, "PNG", optimize=True)


def main() -> None:
    icon = Image.open(ICON_SRC).convert("RGBA")
    maskable = Image.open(MASKABLE_SRC).convert("RGBA")
    splash = Image.open(SPLASH_SRC).convert("RGB")

    for folder, px in LAUNCHER.items():
        resized = icon.resize((px, px), Image.Resampling.LANCZOS)
        save_png(resized, RES / folder / "ic_launcher.png")
        save_png(resized, RES / folder / "ic_launcher_round.png")

    for folder, px in FOREGROUND.items():
        resized = maskable.resize((px, px), Image.Resampling.LANCZOS)
        save_png(resized, RES / folder / "ic_launcher_foreground.png")

    for folder, size in SPLASH.items():
        save_png(cover(splash, size).convert("RGBA"), RES / folder / "splash.png")

    save_png(cover(splash, (480, 800)).convert("RGBA"), RES / "drawable" / "splash.png")


if __name__ == "__main__":
    main()
