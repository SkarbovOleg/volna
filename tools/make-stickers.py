"""Рисует набор SVG-стикеров «Волны» — круглый персонаж с разными эмоциями.

    python tools/make-stickers.py
"""
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "public", "stickers")

INK = "#151a26"

STICKERS = {
    "smile": ("Улыбка", "#6d8cff", "#8f7bff"),
    "laugh": ("Смех", "#5ec8ff", "#6d8cff"),
    "love": ("Любовь", "#ff7b9c", "#ff9d6d"),
    "sad": ("Грусть", "#7f9ad9", "#9b8ce0"),
    "angry": ("Злость", "#ff7a5c", "#ff5c8a"),
    "sleepy": ("Сон", "#8bb4ff", "#a9a2ff"),
    "cool": ("Крутость", "#63e0c8", "#4fb8ff"),
    "party": ("Праздник", "#ffb54d", "#ff7a9c"),
    "wink": ("Подмигивание", "#7ad0ff", "#8f7bff"),
    "think": ("Раздумье", "#9aa8c9", "#7f8eb3"),
    "shock": ("Шок", "#ffd166", "#ff9d6d"),
    "cry": ("Слёзы", "#6f9fe0", "#8f7bff"),
    "star": ("Звёзды", "#8f7bff", "#6d8cff"),
    "fire": ("Огонь", "#ff8a5c", "#ff5c5c"),
    "devil": ("Чёртик", "#b18cff", "#8f5cff"),
    "angel": ("Ангел", "#b9e3ff", "#8fd0ff"),
}


def face(body_a, body_b):
    return f"""
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="{body_a}"/>
      <stop offset="1" stop-color="{body_b}"/>
    </linearGradient>
  </defs>
  <circle cx="60" cy="62" r="47" fill="url(#g)"/>
  <circle cx="60" cy="62" r="47" fill="none" stroke="rgba(0,0,0,.18)" stroke-width="2"/>
  <ellipse cx="43" cy="49" rx="10" ry="7" fill="rgba(255,255,255,.28)"/>"""


def eyes_dots():
    return f"""
  <circle cx="45" cy="58" r="5" fill="{INK}"/>
  <circle cx="75" cy="58" r="5" fill="{INK}"/>"""


def eyes_closed():
    return f"""
  <path d="M38 58 q7 -8 14 0" fill="none" stroke="{INK}" stroke-width="4.5" stroke-linecap="round"/>
  <path d="M68 58 q7 -8 14 0" fill="none" stroke="{INK}" stroke-width="4.5" stroke-linecap="round"/>"""


def heart(cx, cy, s=1.0):
    return (
        f'<path transform="translate({cx},{cy}) scale({s})" '
        f'd="M0 6 C-6 0 -10 -4 -10 -8 C-10 -12 -7 -14 -4 -14 C-2 -14 0 -12 0 -10 '
        f'C0 -12 2 -14 4 -14 C7 -14 10 -12 10 -8 C10 -4 6 0 0 6 Z" fill="#ff4d6d"/>'
    )


def svg(body_a, body_b, inner):
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="120" height="120">'
        + face(body_a, body_b)
        + inner
        + "\n</svg>\n"
    )


def build():
    parts = {}

    parts["smile"] = eyes_dots() + f"""
  <path d="M42 74 q18 16 36 0" fill="none" stroke="{INK}" stroke-width="5" stroke-linecap="round"/>"""

    parts["laugh"] = eyes_closed() + f"""
  <path d="M40 71 q20 26 40 0 z" fill="{INK}"/>
  <path d="M52 84 q8 7 16 0 z" fill="#ff7b9c"/>"""

    parts["love"] = heart(45, 56, 0.95) + heart(75, 56, 0.95) + f"""
  <path d="M46 76 q14 12 28 0" fill="none" stroke="{INK}" stroke-width="5" stroke-linecap="round"/>"""

    parts["sad"] = eyes_dots() + f"""
  <path d="M44 78 q16 -14 32 0" fill="none" stroke="{INK}" stroke-width="5" stroke-linecap="round"/>
  <path d="M72 62 q7 10 0 15 q-7 -5 0 -15 z" fill="#4fb8ff"/>"""

    parts["angry"] = f"""
  <path d="M34 48 l16 7" stroke="{INK}" stroke-width="5" stroke-linecap="round"/>
  <path d="M86 48 l-16 7" stroke="{INK}" stroke-width="5" stroke-linecap="round"/>
  <circle cx="45" cy="62" r="5" fill="{INK}"/>
  <circle cx="75" cy="62" r="5" fill="{INK}"/>
  <path d="M44 80 q16 -10 32 0" fill="none" stroke="{INK}" stroke-width="5" stroke-linecap="round"/>"""

    parts["sleepy"] = eyes_closed() + f"""
  <path d="M50 78 q10 8 20 0" fill="none" stroke="{INK}" stroke-width="4.5" stroke-linecap="round"/>
  <path d="M94 12 h14 l-14 15 h14" fill="none" stroke="{INK}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M108 32 h9 l-9 10 h9" fill="none" stroke="{INK}" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>"""

    parts["cool"] = f"""
  <rect x="28" y="50" width="28" height="18" rx="7" fill="{INK}"/>
  <rect x="64" y="50" width="28" height="18" rx="7" fill="{INK}"/>
  <path d="M56 57 h8" stroke="{INK}" stroke-width="4" stroke-linecap="round"/>
  <path d="M48 80 q10 8 20 0" fill="none" stroke="{INK}" stroke-width="4.5" stroke-linecap="round"/>"""

    parts["party"] = eyes_dots() + f"""
  <path d="M60 4 l24 40 l-48 0 z" fill="#ffd166"/>
  <circle cx="60" cy="4" r="6" fill="#ff7a9c"/>
  <path d="M48 26 h24" stroke="#ff9d6d" stroke-width="4"/>
  <path d="M42 72 q18 18 36 0 z" fill="{INK}"/>
  <circle cx="22" cy="34" r="4" fill="#4fb8ff"/>
  <circle cx="100" cy="44" r="3.5" fill="#ffd166"/>
  <circle cx="94" cy="20" r="3" fill="#ff7a9c"/>"""

    parts["wink"] = f"""
  <circle cx="45" cy="58" r="5" fill="{INK}"/>
  <path d="M66 58 q9 -7 18 0" fill="none" stroke="{INK}" stroke-width="4.5" stroke-linecap="round"/>
  <path d="M42 74 q18 16 36 0" fill="none" stroke="{INK}" stroke-width="5" stroke-linecap="round"/>"""

    parts["think"] = f"""
  <circle cx="47" cy="56" r="5" fill="{INK}"/>
  <circle cx="73" cy="56" r="5" fill="{INK}"/>
  <path d="M48 78 q12 6 24 0" fill="none" stroke="{INK}" stroke-width="4.5" stroke-linecap="round"/>
  <circle cx="84" cy="30" r="4" fill="#fff" opacity=".55"/>
  <circle cx="96" cy="20" r="5" fill="#fff" opacity=".75"/>
  <circle cx="110" cy="8" r="6" fill="#fff" opacity=".95"/>"""

    parts["shock"] = f"""
  <circle cx="45" cy="57" r="9" fill="#fff" stroke="{INK}" stroke-width="2"/>
  <circle cx="45" cy="57" r="3.4" fill="{INK}"/>
  <circle cx="75" cy="57" r="9" fill="#fff" stroke="{INK}" stroke-width="2"/>
  <circle cx="75" cy="57" r="3.4" fill="{INK}"/>
  <ellipse cx="60" cy="82" rx="9" ry="11" fill="{INK}"/>"""

    parts["cry"] = f"""
  <path d="M38 56 q7 -8 14 0" fill="none" stroke="{INK}" stroke-width="4.5" stroke-linecap="round"/>
  <path d="M68 56 q7 -8 14 0" fill="none" stroke="{INK}" stroke-width="4.5" stroke-linecap="round"/>
  <path d="M44 78 q16 -14 32 0" fill="none" stroke="{INK}" stroke-width="5" stroke-linecap="round"/>
  <path d="M45 64 v16" stroke="#8fd0ff" stroke-width="6" stroke-linecap="round"/>
  <path d="M75 64 v20" stroke="#8fd0ff" stroke-width="6" stroke-linecap="round"/>"""

    def star_points(cx, cy, r):
        import math as _m

        return " ".join(
            f"{cx + (r if i % 2 == 0 else r * 0.45) * _m.cos(-1.5708 + i * 0.6283):.1f},"
            f"{cy + (r if i % 2 == 0 else r * 0.45) * _m.sin(-1.5708 + i * 0.6283):.1f}"
            for i in range(10)
        )

    parts["star"] = f"""
  <polygon points="{star_points(45, 58, 10)}" fill="#ffd166" stroke="#ffb54d" stroke-width="1.5"/>
  <polygon points="{star_points(75, 58, 10)}" fill="#ffd166" stroke="#ffb54d" stroke-width="1.5"/>
  <path d="M42 74 q18 16 36 0" fill="none" stroke="{INK}" stroke-width="5" stroke-linecap="round"/>"""

    parts["fire"] = eyes_dots() + f"""
  <path d="M60 2 c8 10 12 16 12 22 a12 12 0 0 1 -24 0 c0 -6 4 -12 12 -22 z" fill="#ff8a3c"/>
  <path d="M60 12 c4 6 6 9 6 12 a6 6 0 0 1 -12 0 c0 -3 2 -6 6 -12 z" fill="#ffd166"/>
  <path d="M42 74 q18 16 36 0" fill="none" stroke="{INK}" stroke-width="5" stroke-linecap="round"/>"""

    parts["devil"] = eyes_dots() + f"""
  <path d="M30 44 l14 -18 l4 20 z" fill="{INK}"/>
  <path d="M90 44 l-14 -18 l-4 20 z" fill="{INK}"/>
  <path d="M40 46 l14 6" stroke="{INK}" stroke-width="4.5" stroke-linecap="round"/>
  <path d="M80 46 l-14 6" stroke="{INK}" stroke-width="4.5" stroke-linecap="round"/>
  <path d="M42 76 q18 18 36 0" fill="none" stroke="{INK}" stroke-width="5" stroke-linecap="round"/>"""

    parts["angel"] = f"""
  <ellipse cx="60" cy="6" rx="26" ry="6" fill="none" stroke="#ffd166" stroke-width="4"/>
  <path d="M38 56 q7 -7 14 0" fill="none" stroke="{INK}" stroke-width="4.5" stroke-linecap="round"/>
  <path d="M68 56 q7 -7 14 0" fill="none" stroke="{INK}" stroke-width="4.5" stroke-linecap="round"/>
  <path d="M46 74 q14 12 28 0" fill="none" stroke="{INK}" stroke-width="5" stroke-linecap="round"/>"""

    for key, inner in parts.items():
        title, a, b = STICKERS[key]
        with open(os.path.join(OUT, f"{key}.svg"), "w", encoding="utf-8") as fh:
            fh.write(svg(a, b, inner))
        print("стикер", key, "-", title)


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    build()
