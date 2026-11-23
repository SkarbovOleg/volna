"""Рисует иконки «Волны»: PWA (192/512) и Android mipmap-*.

    python tools/make-icons.py
"""
import math
import os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

START = (109, 140, 255)   # #6d8cff
END = (160, 123, 255)     # #a07bff

WAVES = [
    # (смещение по вертикали, амплитуда, толщина, прозрачность)
    (-0.055, 0.052, 0.062, 1.0),
    (0.085, 0.052, 0.052, 0.55),
]


def gradient(size, start, end):
    img = Image.new("RGB", (size, size))
    px = img.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * (size - 1))
            px[x, y] = tuple(round(start[i] + (end[i] - start[i]) * t) for i in range(3))
    return img


def draw_icon(size):
    scale = 4
    big = size * scale
    img = gradient(big, START, END)

    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, big - 1, big - 1], radius=int(big * 0.225), fill=255)

    base = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    base.paste(img, (0, 0), mask)

    layer = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    for offset, amp, thickness, alpha in WAVES:
        stroke = max(2, int(big * thickness))
        steps = max(180, int(big / 2))
        points = []
        for i in range(steps + 1):
            t = i / steps
            x = big * (0.14 + 0.72 * t)
            y = big * (0.5 + offset + amp * math.sin(t * math.pi * 2))
            points.append((x, y))
        # толстая линия с круглыми концами и стыками
        for (x, y) in points:
            d.ellipse([x - stroke / 2, y - stroke / 2, x + stroke / 2, y + stroke / 2],
                      fill=(255, 255, 255, int(255 * alpha)))

    base = Image.alpha_composite(base, layer)
    return base.resize((size, size), Image.LANCZOS)


def main():
    out_pwa = os.path.join(ROOT, "public", "icons")
    os.makedirs(out_pwa, exist_ok=True)
    for size in (192, 512):
        draw_icon(size).save(os.path.join(out_pwa, f"icon-{size}.png"), optimize=True)
        print("pwa", size)

    dens = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
    for name, size in dens.items():
        folder = os.path.join(ROOT, "android", "res", f"mipmap-{name}")
        os.makedirs(folder, exist_ok=True)
        icon = draw_icon(size)
        icon.save(os.path.join(folder, "ic_launcher.png"), optimize=True)
        # круглая версия для адаптивных лончеров
        rounded = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        m = Image.new("L", (size, size), 0)
        ImageDraw.Draw(m).ellipse([0, 0, size - 1, size - 1], fill=255)
        rounded.paste(icon, (0, 0), m)
        rounded.save(os.path.join(folder, "ic_launcher_round.png"), optimize=True)
        print("android", name, size)

    draw_icon(512).save(os.path.join(ROOT, "android", "icon-512.png"), optimize=True)


if __name__ == "__main__":
    main()
