"""Generate Koode's placeholder brand mark and development sample images.

Usage: python3 apps/mobile/scripts/generate_assets.py
Requires Pillow. Output is deterministic, so re-running produces identical files.
Sample images are abstract and generated locally: no third-party photos and no
network requests in development data.
"""

from pathlib import Path
import random

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"
DEV = ASSETS / "dev"
SS = 4  # supersampling factor for smooth edges


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(len(a)))


def hex_rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i : i + 2], 16) for i in (0, 2, 4))


def gradient(size, top, bottom, diagonal=False):
    w, h = size
    img = Image.new("RGB", size)
    px = img.load()
    for y in range(h):
        for x in range(w):
            t = ((x / w) * 0.35 + (y / h) * 0.65) if diagonal else y / h
            px[x, y] = lerp(top, bottom, t)
    return img


def bubble_glyph(size, fill_main, fill_back):
    """Two overlapping rounded speech bubbles — the Koode mark."""
    s = size * SS
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # back bubble (top-right)
    d.rounded_rectangle([s * 0.36, s * 0.18, s * 0.86, s * 0.58], radius=s * 0.17, fill=fill_back)
    d.polygon([(s * 0.70, s * 0.52), (s * 0.80, s * 0.66), (s * 0.60, s * 0.56)], fill=fill_back)
    # front bubble (bottom-left)
    d.rounded_rectangle([s * 0.14, s * 0.36, s * 0.70, s * 0.80], radius=s * 0.19, fill=fill_main)
    d.polygon([(s * 0.24, s * 0.74), (s * 0.16, s * 0.90), (s * 0.40, s * 0.78)], fill=fill_main)
    return img.resize((size, size), Image.LANCZOS)


def brand():
    navy, blue = hex_rgb("#0E1430"), hex_rgb("#3563F0")
    # iOS / store icon: opaque, full-bleed
    icon = gradient((1024, 1024), navy, blue, diagonal=True).convert("RGBA")
    glyph = bubble_glyph(1024, (255, 255, 255, 255), (255, 255, 255, 110))
    icon.alpha_composite(glyph)
    icon.convert("RGB").save(ASSETS / "icon.png")

    # Splash: accent glyph on transparent, readable on light and dark splash backgrounds
    bubble_glyph(512, blue + (255,), blue + (110,)).save(ASSETS / "splash-icon.png")

    # Android adaptive icon: glyph inside the 66% safe zone
    fg = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    fg.alpha_composite(bubble_glyph(620, (255, 255, 255, 255), (255, 255, 255, 110)), (202, 202))
    fg.save(ASSETS / "android-icon-foreground.png")
    gradient((1024, 1024), navy, blue, diagonal=True).save(ASSETS / "android-icon-background.png")
    mono = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    mono.alpha_composite(bubble_glyph(620, (255, 255, 255, 255), (255, 255, 255, 255)), (202, 202))
    mono.save(ASSETS / "android-icon-monochrome.png")
    icon.resize((48, 48), Image.LANCZOS).convert("RGB").save(ASSETS / "favicon.png")


def scene(name, size, sky_top, sky_bottom, layers, sun=None, seed=1):
    rnd = random.Random(seed)
    w, h = size
    img = gradient(size, hex_rgb(sky_top), hex_rgb(sky_bottom)).convert("RGBA")
    if sun:
        cx, cy, r, color = sun
        glow = Image.new("RGBA", size, (0, 0, 0, 0))
        ImageDraw.Draw(glow).ellipse(
            [cx * w - r * 2, cy * h - r * 2, cx * w + r * 2, cy * h + r * 2], fill=hex_rgb(color) + (90,)
        )
        img.alpha_composite(glow.filter(ImageFilter.GaussianBlur(r)))
        ImageDraw.Draw(img).ellipse(
            [cx * w - r, cy * h - r, cx * w + r, cy * h + r], fill=hex_rgb(color) + (255,)
        )
    for base, amp, color in layers:
        layer = Image.new("RGBA", size, (0, 0, 0, 0))
        pts = [(0, h)]
        phase = rnd.random() * 10
        for x in range(0, w + 20, 20):
            y = base * h + amp * h * (
                0.6 * __import__("math").sin(x / w * 5 + phase)
                + 0.4 * __import__("math").sin(x / w * 13 + phase * 2)
            )
            pts.append((x, y))
        pts.append((w, h))
        ImageDraw.Draw(layer).polygon(pts, fill=hex_rgb(color) + (255,))
        img.alpha_composite(layer)
    img.convert("RGB").filter(ImageFilter.GaussianBlur(0.6)).save(DEV / f"{name}.jpg", quality=82)


def samples():
    DEV.mkdir(exist_ok=True)
    scene("sunset", (900, 1200), "#2B1B4A", "#F49A6C",
          [(0.70, 0.04, "#5B2E5A"), (0.80, 0.03, "#3A1E3F"), (0.90, 0.02, "#1F1226")],
          sun=(0.5, 0.62, 70, "#FFD39A"), seed=3)
    scene("ocean", (1200, 900), "#9FD3F5", "#E8F6FF",
          [(0.62, 0.01, "#3A8FC4"), (0.72, 0.012, "#2A75A8"), (0.86, 0.008, "#E9D8B4")],
          sun=(0.78, 0.22, 46, "#FFF6D8"), seed=5)
    scene("forest", (900, 1200), "#CFE8D8", "#F2F7EC",
          [(0.55, 0.06, "#7FB08A"), (0.68, 0.05, "#4E8A60"), (0.82, 0.04, "#2E5E3F")], seed=7)
    scene("mountains", (1200, 900), "#5A7BB5", "#DCE6F5",
          [(0.45, 0.12, "#8DA2C8"), (0.60, 0.10, "#5E739C"), (0.80, 0.05, "#2F3D5C")],
          sun=(0.25, 0.25, 40, "#FFFFFF"), seed=11)
    scene("city", (900, 1200), "#101A3A", "#3B4E8C",
          [(0.62, 0.02, "#1A2348"), (0.75, 0.015, "#121933"), (0.9, 0.01, "#0A0F22")],
          sun=(0.72, 0.18, 28, "#F5F0D8"), seed=13)
    scene("lake", (1200, 900), "#F7C9A8", "#FBE7D7",
          [(0.50, 0.05, "#B98C9E"), (0.66, 0.004, "#8FB6CF"), (0.9, 0.01, "#6C93AE")],
          sun=(0.6, 0.4, 52, "#FFF1D6"), seed=17)


if __name__ == "__main__":
    brand()
    samples()
    print("Generated brand assets and dev samples")
