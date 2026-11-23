"""Рисует демо-фотографию для переписки: закат над сопками.

    python tools/make-demo-photo.py assets/demo-photo.jpg
"""
import sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

W, H = 1200, 800


def gradient(stops):
    img = np.zeros((H, W, 3), dtype=np.float64)
    for y in range(H):
        t = y / (H - 1)
        for i in range(len(stops) - 1):
            t0, c0 = stops[i]
            t1, c1 = stops[i + 1]
            if t0 <= t <= t1:
                k = (t - t0) / (t1 - t0) if t1 > t0 else 0
                img[y, :, :] = [c0[j] + (c1[j] - c0[j]) * k for j in range(3)]
                break
    return img


def ridge(x, base, waves):
    y = np.full(x.shape, float(base))
    for amp, freq, phase in waves:
        y = y + amp * np.sin(2 * np.pi * freq * x / W + phase)
    return y


def main(out):
    rng = np.random.default_rng(11)
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float64)

    sky = gradient(
        [
            (0.00, (10, 16, 36)),
            (0.22, (26, 38, 76)),
            (0.45, (64, 72, 118)),
            (0.62, (124, 94, 124)),
            (0.74, (192, 118, 104)),
            (0.83, (240, 166, 118)),
            (0.92, (255, 206, 160)),
            (1.00, (255, 230, 198)),
        ]
    )

    # солнце и его свет
    sx, sy, sr = 818, 566, 38
    dist = np.hypot(xx - sx, yy - sy)
    glow = np.clip(1 - dist / 380, 0, 1) ** 2.4
    sky += glow[:, :, None] * np.array([255, 190, 124]) * 0.5
    disk = np.clip(1 - dist / (sr + 2), 0, 1) ** 0.35
    sky = sky * (1 - disk[:, :, None]) + np.array([255, 246, 222]) * disk[:, :, None]

    img = sky

    # облачные полосы, подсвеченные снизу
    clouds = Image.new("L", (W, H), 0)
    cd = ImageDraw.Draw(clouds)
    for cx, cy, cw, ch in [(760, 448, 300, 12), (980, 486, 220, 9), (520, 402, 210, 8), (860, 520, 360, 7)]:
        cd.ellipse([cx - cw, cy - ch, cx + cw, cy + ch], fill=120)
    clouds = np.asarray(clouds.filter(ImageFilter.GaussianBlur(16))).astype(np.float64) / 255 * 0.55
    img += clouds[:, :, None] * np.array([255, 172, 120]) * 0.9

    # сопки: далёкие светлее и дымчатее, ближние почти чёрные
    layers = [
        dict(base=612, waves=[(22, 0.9, 0.4), (11, 2.2, 2.1), (5, 4.3, 1.0)],
             top=(96, 78, 116), bottom=(78, 62, 98), rim=0.55),
        dict(base=676, waves=[(26, 0.65, 1.7), (14, 1.7, 0.3), (7, 3.9, 2.6)],
             top=(46, 36, 62), bottom=(16, 12, 26), rim=0.35),
    ]

    for layer in layers:
        line = ridge(xx[0], layer["base"], layer["waves"])[None, :]
        mask = yy >= line
        depth = np.clip((yy - line) / (H - line), 0, 1)[:, :, None]
        top = np.array(layer["top"], dtype=np.float64)
        bottom = np.array(layer["bottom"], dtype=np.float64)
        color = top * (1 - depth) + bottom * depth
        img = img * (1 - mask[:, :, None]) + color * mask[:, :, None]

        # светлый контур гребня со стороны солнца
        band = np.exp(-((yy - line) ** 2) / (2 * 1.5**2))
        img += (band * glow * layer["rim"] * 255)[:, :, None] * np.array([1.0, 0.72, 0.5])

    # зерно и виньетка
    img = img + rng.normal(0, 3.0, (H, W, 1))
    vignette = 1 - 0.32 * np.clip(
        np.hypot((xx - W / 2) / (W / 2), (yy - H / 2) / (H / 2)) - 0.5, 0, 2
    ) ** 1.5
    img = img * vignette[:, :, None]

    Image.fromarray(np.clip(img, 0, 255).astype(np.uint8)).save(out, quality=88, optimize=True)
    print("saved", out)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "assets/demo-photo.jpg")
