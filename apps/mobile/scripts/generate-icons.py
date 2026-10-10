#!/usr/bin/env python3
"""
Generate Koode's app icons and splash artwork (requires Pillow).

    python3 apps/mobile/scripts/generate-icons.py

The mark: two speech bubbles, the front one with a keyhole (private, end-to-end
encrypted conversations). Everything is drawn at 4x and downsampled, so edges
are anti-aliased. Outputs go to apps/mobile/assets/.
"""
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "assets"
SS = 4  # supersampling

# Brand colours (the default "Blue" accent and the dark background token).
NIGHT = (11, 12, 16)
DEEP = (16, 24, 64)
BLUE = (52, 98, 232)
WHITE = (255, 255, 255)


def gradient(size, top, bottom):
    """Diagonal gradient from top-left to bottom-right."""
    w, h = size
    down = Image.linear_gradient("L").resize((w, h))
    across = Image.linear_gradient("L").transpose(Image.Transpose.ROTATE_90).transpose(Image.Transpose.FLIP_TOP_BOTTOM).resize((w, h))
    mask = Image.blend(down, across, 0.5)  # (x + y) / 2
    return Image.composite(Image.new("RGB", size, bottom), Image.new("RGB", size, top), mask)


def bubble(draw_size, box, radius, tail, fill=255):
    """A rounded speech bubble with a tail (as an L mask)."""
    m = Image.new("L", draw_size, 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle(box, radius=radius, fill=fill)
    d.polygon(tail, fill=fill)
    return m


def keyhole(draw_size, cx, cy, r, fill=255):
    m = Image.new("L", draw_size, 0)
    d = ImageDraw.Draw(m)
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=fill)
    d.polygon(
        [(cx - r * 0.55, cy + r * 0.4), (cx + r * 0.55, cy + r * 0.4), (cx + r * 0.85, cy + r * 2.5), (cx - r * 0.85, cy + r * 2.5)],
        fill=fill,
    )
    return m


def mark_masks(n, scale=1.0):
    """Masks (back bubble, front bubble with keyhole) on an n×n canvas; `scale` of the full design."""
    s = n * scale / 1024
    o = n * (1 - scale) / 2
    p = lambda x, y: (o + x * s, o + y * s)  # noqa: E731
    size = (n, n)
    back = bubble(size, (*p(372, 196), *p(872, 640)), 150 * s, [p(640, 560), p(860, 690), p(780, 560)])
    front = bubble(size, (*p(152, 372), *p(712, 816)), 170 * s, [p(232, 740), p(170, 920), p(400, 800)])
    hole = keyhole(size, *p(432, 560), 62 * s)
    front = ImageChops.subtract(front, hole)
    # The back bubble sits behind: hide what the front covers.
    back = ImageChops.subtract(back, bubble(size, (*p(132, 352), *p(732, 836)), 185 * s, [p(212, 760), p(150, 940), p(420, 820)]))
    return back, front


def render(n, background, back_colour, front_colour, scale=1.0, transparent=False):
    big = n * SS
    back, front = mark_masks(big, scale)
    if transparent:
        img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    else:
        img = background((big, big)).convert("RGBA")
    for mask, colour in ((back, back_colour), (front, front_colour)):
        alpha = mask.point(lambda v, a=colour[3]: v * a // 255)
        layer = Image.new("RGBA", (big, big), colour[:3] + (0,))
        layer.putalpha(alpha)
        img.alpha_composite(layer)
    return img.resize((n, n), Image.LANCZOS)


def main():
    blue_bg = lambda size: gradient(size, DEEP, BLUE)  # noqa: E731
    night_bg = lambda size: gradient(size, NIGHT, (24, 30, 52))  # noqa: E731
    translucent = (255, 255, 255, 120)

    # iOS: light, dark and tinted (grayscale on black) appearances.
    render(1024, blue_bg, translucent, WHITE + (255,)).convert("RGB").save(OUT / "icon.png")
    render(1024, night_bg, (92, 130, 240, 150), (120, 156, 255, 255)).convert("RGB").save(OUT / "icon-dark.png")
    tinted = render(1024, lambda s: Image.new("RGB", s, (0, 0, 0)), (170, 170, 170, 255), WHITE + (255,))
    tinted.convert("L").save(OUT / "icon-tinted.png")

    # Android adaptive icon: the mark inside the 66% safe zone.
    render(1024, None, translucent, WHITE + (255,), scale=0.62, transparent=True).save(OUT / "android-icon-foreground.png")
    blue_bg((1024, 1024)).save(OUT / "android-icon-background.png")
    mono = render(1024, None, (255, 255, 255, 140), WHITE + (255,), scale=0.62, transparent=True)
    mono.save(OUT / "android-icon-monochrome.png")

    # Splash and in-app mark: the blue mark on transparent (works on light and dark).
    splash = render(512, None, (52, 98, 232, 110), BLUE + (255,), transparent=True)
    splash.save(OUT / "splash-icon.png")
    render(48, blue_bg, translucent, WHITE + (255,)).convert("RGB").save(OUT / "favicon.png")
    print("wrote", ", ".join(sorted(p.name for p in OUT.glob("*icon*.png"))), "and favicon.png")


if __name__ == "__main__":
    main()
