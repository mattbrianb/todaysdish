"""Draw today's Instagram images and caption in the diner letterboard style.

Writes to instagram/YYYY-MM-DD/:
  post-1.jpg ... post-5.jpg   1080x1350 carousel: the board, one slide per dish, a sign-off
  story.jpg                   1080x1920 story with the board and the web address
  caption.txt                 the post caption

Usage: python scripts/make_instagram.py [out_dir]
"""
import os
import re
import sys
from datetime import date

from PIL import Image, ImageDraw

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from make_share_card import (  # noqa: E402  (shared drawing helpers)
    CREAM, FELT, FELT_LINE, FRAME, GOLD, INK, LETTER, MEALS, RED,
    draw_spaced, fetch_photo, fit_lines, font, logo_font, short_name, spaced_width,
)

W, H = 1080, 1350
STORY_H = 1920
SITE = "todaysdish.food"
MUTED = (94, 74, 60)


def big_photo_url(url):
    # Spoonacular serves larger copies of the same photo; 636x393 is the biggest
    return re.sub(r"-\d+x\d+\.(jpg|png)$", r"-636x393.\1", url or "")


def checker(d, y, width, sq=40):
    for i in range(width // sq + 1):
        if i % 2 == 0:
            d.rectangle((i * sq, y, i * sq + sq - 1, y + sq - 1), fill=RED)


def centered(d, text, f, cx, y, fill):
    d.text((cx - d.textlength(text, font=f) / 2, y), text, font=f, fill=fill)


def board(d, box, rows):
    """Wooden frame + grooved felt, rows centred vertically: (text, font, colour, tracking, advance)."""
    l, t, r, b = box
    d.rounded_rectangle(box, radius=10, fill=FRAME)
    fl, ft, fr, fb = l + 18, t + 18, r - 18, b - 18
    d.rectangle((fl, ft, fr, fb), fill=FELT)
    for y in range(ft + 7, fb, 10):
        d.line((fl, y, fr, y), fill=FELT_LINE, width=3)
    y = ft + ((fb - ft) - sum(row[4] for row in rows)) / 2
    for text, f, colour, tracking, advance in rows:
        draw_spaced(d, text, f, (l + r) / 2, y, colour, tracking)
        y += advance


def menu_rows(d, data, width, scale=1.0):
    s = lambda v: int(v * scale)
    day = date.fromisoformat(data["date"])
    rows = [
        ("TODAY'S SPECIALS", font(s(58), "Bold"), LETTER, 7, s(78)),
        (day.strftime("%a · %d · %b").upper().replace(" 0", " "), font(s(34)), LETTER, 6, s(66)),
    ]
    for key, label in MEALS:
        dish = data.get(key)
        if not dish:
            continue
        rows.append((label.upper(), font(s(32), "Bold"), GOLD, 6, s(46)))
        f, lines = fit_lines(d, short_name(dish["name"]), width, (s(50), s(46), s(42), s(38), s(34)), 4)
        for i, line in enumerate(lines):
            rows.append((line, f, LETTER, 4, f.size + (s(34) if i == len(lines) - 1 else s(8))))
    rows.append(("NO SUBSTITUTIONS", font(s(26)), LETTER, 6, s(26)))
    return rows


def paste_photo(img, url, box, radius=18):
    l, t, r, b = box
    size = (r - l, b - t)
    photo = fetch_photo(big_photo_url(url), size) or fetch_photo(url, size)
    if photo:
        mask = Image.new("L", size, 0)
        ImageDraw.Draw(mask).rounded_rectangle((0, 0, size[0] - 1, size[1] - 1), radius=radius, fill=255)
        img.paste(photo[0], (l, t), mask)
    else:
        ImageDraw.Draw(img).rounded_rectangle(box, radius=radius, fill=FELT)


def pill(d, text, f, cx, y, fill, colour, pad=(28, 14), tracking=4):
    w = spaced_width(d, text, f, tracking)
    h = f.size + pad[1] * 2
    d.rounded_rectangle((cx - w / 2 - pad[0], y, cx + w / 2 + pad[0], y + h), radius=h / 2, fill=fill)
    draw_spaced(d, text, f, cx, y + pad[1] - 2, colour, tracking)
    return h


def footer(d, img_h, text="Full recipes at " + SITE):
    centered(d, text, font(40, "Bold"), W / 2, img_h - 112, RED)
    checker(d, img_h - 40, W)


def slide_board(data):
    img = Image.new("RGB", (W, H), CREAM)
    d = ImageDraw.Draw(img)
    checker(d, 0, W)
    centered(d, "Today's Dish", logo_font(96), W / 2, 50, RED)
    draw_spaced(d, "ONE MENU · EVERYBODY EATS", font(30, "Bold"), W / 2, 240, INK, 7)
    board(d, (70, 300, W - 70, 892), menu_rows(d, data, W - 260, 0.9))
    # A strip of today's three photos under the board
    x, y, size, gap = 100, 916, 280, 20
    for key, _ in MEALS:
        dish = data.get(key) or {}
        paste_photo(img, dish.get("image"), (x, y, x + size, y + size))
        x += size + gap
    footer(d, H, f"Tap I'm eating this at {SITE}  ·  {TREND_TAG}")
    return img


def slide_dish(data, key, label, number):
    dish = data[key]
    img = Image.new("RGB", (W, H), CREAM)
    d = ImageDraw.Draw(img)
    checker(d, 0, W)
    pill(d, f"{number}  ·  {label.upper()}", font(34, "Bold"), W / 2, 92, FELT, GOLD)
    paste_photo(img, dish.get("image"), (60, 190, W - 60, 190 + 720), radius=24)
    f, lines = fit_lines(d, short_name(dish["name"]), W - 140, (76, 68, 60, 54, 48), 3)
    y = 960
    for line in lines:
        draw_spaced(d, line, font(f.size, "Bold"), W / 2, y, INK, 3)
        y += f.size + 10
    meta = []
    if dish.get("cookTime"):
        h, m = divmod(int(dish["cookTime"]), 60)
        meta.append(" ".join(filter(None, [f"{h} hr" if h else "", f"{m} min" if m else ""])))
    if dish.get("ingredients"):
        meta.append(f"{len(dish['ingredients'])} ingredients")
    centered(d, "  ·  ".join(meta), font(38), W / 2, y + 18, MUTED)
    footer(d, H, "Recipe at " + SITE)
    return img


def slide_signoff(data):
    img = Image.new("RGB", (W, H), CREAM)
    d = ImageDraw.Draw(img)
    checker(d, 0, W)
    centered(d, "Today's Dish", logo_font(96), W / 2, 90, RED)
    rows = [
        ("ONE MENU", font(64, "Bold"), LETTER, 8, 92),
        ("EVERYBODY EATS", font(64, "Bold"), LETTER, 8, 120),
        ("EATING ONE TODAY?", font(40), GOLD, 6, 56),
        ("TAP I'M EATING THIS", font(40), GOLD, 6, 100),
        ("NEW MENU EVERY MORNING", font(30), LETTER, 6, 30),
    ]
    board(d, (90, 280, W - 90, 900), rows)
    centered(d, SITE, font(72, "Bold"), W / 2, 960, RED)
    centered(d, "Post your plate with " + TREND_TAG, font(40, "Bold"), W / 2, 1060, INK)
    checker(d, H - 40, W)
    return img


def story(data):
    img = Image.new("RGB", (W, STORY_H), CREAM)
    d = ImageDraw.Draw(img)
    checker(d, 0, W)
    # Instagram covers roughly the top and bottom 250px of a story with its own UI
    centered(d, "Today's Dish", logo_font(110), W / 2, 200, RED)
    draw_spaced(d, "ONE MENU · EVERYBODY EATS", font(34, "Bold"), W / 2, 406, INK, 7)
    board(d, (70, 476, W - 70, 1150), menu_rows(d, data, W - 260, 1.08))
    x, y, size, gap = 70, 1180, 300, 20
    for key, _ in MEALS:
        dish = data.get(key) or {}
        paste_photo(img, dish.get("image"), (x, y, x + size, y + size))
        x += size + gap
    centered(d, "Tap I'm eating this at", font(40, "Bold"), W / 2, 1510, INK)
    pill(d, SITE.upper(), font(46, "Bold"), W / 2, 1566, RED, (255, 255, 255), pad=(40, 22), tracking=5)
    centered(d, TREND_TAG, font(44, "Bold"), W / 2, 1668, RED)
    checker(d, STORY_H - 40, W)
    return img


# ---- Captions -----------------------------------------------------------------
# Every caption follows the same shape, with each part rotated so no two days read
# alike: hook (the only line people see before "more"), the menu, one detail,
# a question (comments lift reach), a save/share nudge, a route to the website,
# and five hashtags (Instagram now favours a few relevant tags over walls of them).
# Parts rotate through shuffled lists by day number, so re-running a day gives the
# same caption and consecutive days don't repeat a line.

LAUNCH = date(2026, 4, 29)
COUNTER_URL = "https://todaysdish-ingredients.mattbrianburnett.workers.dev/eats"

HOOKS = [
    "Today's specials are on the board 🍽️",
    "Breakfast, lunch and dinner: sorted 🍽️",
    "Stop scrolling for dinner ideas. Here's today's menu 🍽️",
    "Day {day_no} of everybody eating the same thing 🍽️",
    "No more \"what's for dinner?\" Tonight it's {dinner} 🍽️",
    "Your whole day of eating, decided 🍽️",
    "The menu is in. No substitutions 🍽️",
    "Three meals. Zero decisions 🍽️",
]
WEEKDAY_HOOKS = {
    0: "New week, zero decisions. Monday's menu 🍽️",
    4: "Friday menu is up 🍽️",
    5: "Weekend specials are on the board 🍽️",
    6: "Sunday sorted 🍽️",
}
QUESTIONS = [
    "Which one are you making: breakfast, lunch or dinner? 👇",
    "Rate today's board out of 10 👇",
    "Would you eat all three today? Yes or no 👇",
    "Which dish would you swap out? (We don't do substitutions 😉) 👇",
    "Drop a 🍽️ if you're eating one of these today",
    "Be honest: what would you have eaten without this? 👇",
]
NUDGES = [
    "Send this to whoever always asks \"what's for dinner?\"",
    "Save this so tonight's dinner is already decided.",
    "Tag the person you're cooking with tonight.",
    "Share it with your group chat and all eat the same thing.",
    "Save it now, thank yourself at 6pm.",
]
# Instagram is the social layer; the website is where the trend happens, so every
# call to action sends people to tap "I'm eating this" there
CTAS = [
    "Eating one? Tap \"I'm eating this\" on todaysdish.food and join the count (link in bio).",
    "Keep your streak going: tap \"I'm eating this\" at todaysdish.food (link in bio).",
    "See how many people are eating today's specials at todaysdish.food (link in bio).",
    "Full recipes and the \"I'm eating this\" button: todaysdish.food (link in bio).",
    "New menu every morning at 6 on todaysdish.food. Tap \"I'm eating this\" and come back tomorrow.",
]
TREND_TAG = "#TodaysDish"
SOCIAL_PROOF_FROM = 20  # a small number in a public post reads as nobody's here
TAGS = [
    "#whatsfordinner", "#mealideas", "#easyrecipes", "#homecooking", "#dinnerideas",
    "#breakfastideas", "#lunchideas", "#mealinspo", "#foodie", "#recipeoftheday",
    "#southafricanfood", "#mzansifood", "#capetownfoodie", "#joburgfoodie",
    "#weeknightdinner", "#simplerecipes",
]


def nice_time(minutes):
    h, m = divmod(int(minutes), 60)
    return " ".join(filter(None, [f"{h} hr" if h else "", f"{m} min" if m else ""]))


def yesterday_count(day):
    """People who tapped "I'm eating this" yesterday, from the site's counter; None if unknown."""
    try:
        import requests
        y = date.fromordinal(day.toordinal() - 1).isoformat()
        r = requests.get(COUNTER_URL, params={"day": y}, timeout=10)
        return r.json().get("people") if r.ok else None
    except Exception:
        return None


def rotate(items, day_no, salt):
    """Walk a shuffled copy of the list, one item a day, so nothing repeats until all are used."""
    import random
    cycle, pos = divmod(day_no, len(items))
    order = list(range(len(items)))
    random.Random(f"{salt}-{cycle}").shuffle(order)
    return items[order[pos]]


def caption(data, people_yesterday=None):
    import random
    day = date.fromisoformat(data["date"])
    rng = random.Random(data["date"])
    day_no = (day - LAUNCH).days + 1
    dishes = {k: data[k] for k, _ in MEALS if data.get(k)}

    hook = WEEKDAY_HOOKS.get(day.weekday()) if rng.random() < 0.5 else None
    hook = (hook or rotate(HOOKS, day_no, "hook")).format(
        day_no=day_no, dinner=short_name(dishes.get("dinner", {}).get("name", "something good")))

    lines = [hook, day.strftime("%A %d %B").replace(" 0", " "), ""]
    for key, label in MEALS:
        if key in dishes:
            lines.append(f"{label}: {short_name(dishes[key]['name'])}")
    lines.append("")

    # One concrete detail: real social proof when there is some, else the quickest dish
    timed = [(d["cookTime"], short_name(d["name"])) for d in dishes.values() if d.get("cookTime")]
    if people_yesterday and people_yesterday >= SOCIAL_PROOF_FROM:
        lines.append(f"{people_yesterday:,} people ate Today's Dish yesterday. Join them today.")
    elif timed:
        t, name = min(timed)
        lines.append(f"Quickest one today: {name}, ready in {nice_time(t)}.")

    lines += [rotate(QUESTIONS, day_no, "q"), rotate(NUDGES, day_no, "nudge"), "",
              rotate(CTAS, day_no, "cta"),
              f"Made it? Post your plate with {TREND_TAG} 📸", ""]
    lines.append(" ".join([TREND_TAG] + rng.sample(TAGS, 4)))
    return "\n".join(lines) + "\n"


def main():
    import json
    with open("today.json", encoding="utf-8") as f:
        data = json.load(f)
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join("instagram", data["date"])
    os.makedirs(out, exist_ok=True)

    slides = [slide_board(data)]
    for n, (key, label) in enumerate(MEALS, start=2):
        if data.get(key):
            slides.append(slide_dish(data, key, label, n - 1))
    slides.append(slide_signoff(data))
    for i, s in enumerate(slides, start=1):
        s.save(os.path.join(out, f"post-{i}.jpg"), quality=90, optimize=True, progressive=True)
    story(data).save(os.path.join(out, "story.jpg"), quality=90, optimize=True, progressive=True)
    with open(os.path.join(out, "caption.txt"), "w", encoding="utf-8") as f:
        f.write(caption(data, yesterday_count(date.fromisoformat(data["date"]))))
    print(f"wrote {len(slides)} post slides, story.jpg and caption.txt to {out}")


if __name__ == "__main__":
    main()
