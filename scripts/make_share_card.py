"""Letterboard drawing helpers, used by make_instagram.py and make_preview_card.py.

No longer run by the daily job: shares now use the plain website with the fixed card
from make_preview_card.py. Running it by hand still draws a dated share page:

Outputs (paths relative to the repo root):
  og.jpg                 latest card, used by index.html's preview tags
  share/YYYY-MM-DD.jpg   the same card under a dated name
  share/YYYY-MM-DD.html  tiny page with preview tags that forwards visitors to the site

Shared links point at the dated page so chat apps that cache previews per URL
(WhatsApp, Facebook) show that day's dishes instead of an old card.
"""
import html
import io
import json
import os
from datetime import date, timedelta

import requests
from PIL import Image, ImageDraw, ImageFont, ImageOps

SITE_URL = os.getenv("SITE_URL", "https://www.todaysdish.food/")
KEEP_DAYS = 14

W, H = 1200, 630
CREAM = (243, 233, 216)
INK = (43, 26, 18)
RED = (168, 38, 31)
FRAME = (138, 90, 53)
FELT = (29, 29, 29)
FELT_LINE = (38, 38, 38)
LETTER = (244, 244, 240)
GOLD = (242, 193, 78)

FONT_DIR = os.path.join(os.path.dirname(__file__), "..", "assets", "fonts")
MEALS = (("breakfast", "Breakfast"), ("lunch", "Lunch"), ("dinner", "Dinner"))


def font(size, weight="Medium"):
    f = ImageFont.truetype(os.path.join(FONT_DIR, "RobotoCondensed-Variable.ttf"), size)
    f.set_variation_by_name(weight)
    return f


def logo_font(size):
    return ImageFont.truetype(os.path.join(FONT_DIR, "Pacifico-Regular.ttf"), size)


def short_name(name):
    # Same clean-up as the site's board (index.html shortName)
    n = str(name or "").strip()
    for prefix in ("how to make ", "how to cook "):
        if n.lower().startswith(prefix):
            n = n[len(prefix):]
    if n.lower().endswith(" recipe"):
        n = n[: -len(" recipe")]
    return n.strip()


def spaced_width(draw, text, f, spacing):
    return sum(draw.textlength(ch, font=f) for ch in text) + spacing * max(len(text) - 1, 0)


def draw_spaced(draw, text, f, cx, y, fill, spacing):
    """Centre text on cx with letterboard-style tracking."""
    x = cx - spaced_width(draw, text, f, spacing) / 2
    for ch in text:
        draw.text((x, y), ch, font=f, fill=fill)
        x += draw.textlength(ch, font=f) + spacing


def fit_lines(draw, text, max_w, sizes, spacing):
    """Largest size where the text fits on one line, else two lines at the smallest size."""
    text = text.upper()
    for size in sizes:
        f = font(size)
        if spaced_width(draw, text, f, spacing) <= max_w:
            return f, [text]
    f = font(sizes[-1])
    words, lines, line = text.split(), [], ""
    for w in words:
        trial = (line + " " + w).strip()
        if spaced_width(draw, trial, f, spacing) <= max_w or not line:
            line = trial
        else:
            lines.append(line)
            line = w
    lines.append(line)
    if len(lines) > 2:
        lines = [lines[0], " ".join(lines[1:])]
        while spaced_width(draw, lines[1] + "…", f, spacing) > max_w and " " in lines[1]:
            lines[1] = lines[1].rsplit(" ", 1)[0]
        lines[1] += "…"
    return f, lines


def fetch_photo(url, size):
    try:
        r = requests.get(url, timeout=15)
        r.raise_for_status()
        img = Image.open(io.BytesIO(r.content)).convert("RGB")
    except (requests.RequestException, OSError):
        return None
    img = ImageOps.fit(img, size, Image.LANCZOS)
    mask = Image.new("L", size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size[0] - 1, size[1] - 1), radius=14, fill=255)
    return img, mask


def make_card(data):
    img = Image.new("RGB", (W, H), CREAM)
    d = ImageDraw.Draw(img)

    # Checker strip
    sq = 30
    for i in range(W // sq + 1):
        if i % 2 == 0:
            d.rectangle((i * sq, 0, i * sq + sq - 1, sq - 1), fill=RED)

    # Wordmark over the board
    board_l, board_r = 50, 700
    cx = (board_l + board_r) / 2
    logo = ImageFont.truetype(os.path.join(FONT_DIR, "Pacifico-Regular.ttf"), 54)
    lw = d.textlength("Today's Dish", font=logo)
    d.text((cx - lw / 2, 34), "Today's Dish", font=logo, fill=RED)

    # Letterboard: wooden frame, felt with grooves
    top, bottom = 132, 600
    d.rounded_rectangle((board_l, top, board_r, bottom), radius=8, fill=FRAME)
    fl, ft, fr, fb = board_l + 14, top + 14, board_r - 14, bottom - 14
    d.rectangle((fl, ft, fr, fb), fill=FELT)
    for y in range(ft + 6, fb, 8):
        d.line((fl, y, fr, y), fill=FELT_LINE, width=2)

    # Lay the rows out first so the block can be centred on the felt
    day = date.fromisoformat(data["date"])
    rows = [  # (text, font, colour, tracking, space below)
        ("TODAY'S SPECIALS", font(36, "Bold"), LETTER, 5, 50),
        (day.strftime("%a · %d · %b").upper().replace(" 0", " "), font(22), LETTER, 4, 40),
    ]
    max_w = fr - fl - 50
    for key, label in MEALS:
        dish = data.get(key)
        if not dish:
            continue
        rows.append((label.upper(), font(21, "Bold"), GOLD, 4, 30))
        f, lines = fit_lines(d, short_name(dish["name"]), max_w, (32, 30, 28, 26, 24), 3)
        for i, line in enumerate(lines):
            rows.append((line, f, LETTER, 3, f.size + (20 if i == len(lines) - 1 else 6)))
    rows.append(("NO SUBSTITUTIONS", font(18), LETTER, 4, 18))

    y = ft + ((fb - ft) - sum(r[4] for r in rows)) / 2
    for text, f, colour, tracking, advance in rows:
        draw_spaced(d, text, f, cx, y, colour, tracking)
        y += advance

    # Photos down the right
    px, pw, ph, gap = 740, 410, 166, 16
    py = (H + sq - (3 * ph + 2 * gap)) // 2
    for key, _ in MEALS:
        dish = data.get(key) or {}
        photo = fetch_photo(dish.get("image"), (pw, ph)) if dish.get("image") else None
        if photo:
            img.paste(photo[0], (px, py), photo[1])
        else:
            d.rounded_rectangle((px, py, px + pw - 1, py + ph - 1), radius=14, fill=FELT)
        py += ph + gap

    return img


def share_page(data, day):
    names = [f"{label}: {short_name(data[k]['name'])}" for k, label in MEALS if data.get(k)]
    title = "Today's specials, " + day.strftime("%a %d %b").replace(" 0", " ")
    desc = ". ".join(names) + ". Everybody eats the same today."
    e = lambda s: html.escape(s, quote=True)
    page_url = f"{SITE_URL}share/{day}.html"
    image_url = f"{SITE_URL}share/{day}.jpg"
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>{e(title)} | Today's Dish</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="{e(desc)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Today's Dish">
<meta property="og:title" content="{e(title)}">
<meta property="og:description" content="{e(desc)}">
<meta property="og:url" content="{e(page_url)}">
<meta property="og:image" content="{e(image_url)}">
<meta property="og:image:width" content="{W}">
<meta property="og:image:height" content="{H}">
<meta property="og:image:alt" content="{e(title + ': ' + desc)}">
<meta name="twitter:card" content="summary_large_image">
<link rel="canonical" href="{e(SITE_URL)}">
<meta http-equiv="refresh" content="0; url=../">
<script>location.replace("../");</script>
</head>
<body><a href="../">See today's specials</a></body>
</html>
"""


def main():
    with open("today.json", encoding="utf-8") as f:
        data = json.load(f)
    day = date.fromisoformat(data["date"])

    os.makedirs("share", exist_ok=True)
    page_path = f"share/{day}.html"
    if os.path.exists(page_path) and os.getenv("FORCE") != "1":
        print(f"{page_path} already exists, nothing to do")
        return

    card = make_card(data)
    card.save("og.jpg", quality=85, optimize=True, progressive=True)
    card.save(f"share/{day}.jpg", quality=85, optimize=True, progressive=True)
    with open(page_path, "w", encoding="utf-8") as f:
        f.write(share_page(data, day))

    # Keep the folder small: links older than two weeks fall back to the home page's card
    cutoff = str(day - timedelta(days=KEEP_DAYS))
    for name in os.listdir("share"):
        if name[:10] < cutoff:
            os.remove(os.path.join("share", name))
    print(f"wrote og.jpg, share/{day}.jpg and {page_path}")


if __name__ == "__main__":
    main()
