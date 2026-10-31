"""Draw the fixed link-preview card: assets/brand/og-card.jpg (1200x630).

Shared links point at the plain website. Chat apps (WhatsApp, Facebook) keep a link's
preview for days, so the card never names dishes: it asks the question and the message
text carries today's specials. Run once by hand when the design changes:

  python scripts/make_preview_card.py
"""
import os

from PIL import Image, ImageDraw

from make_share_card import (CREAM, FELT, FELT_LINE, FRAME, GOLD, H, INK, LETTER, RED, W,
                             draw_spaced, font, logo_font)

OUT = os.path.join(os.path.dirname(__file__), "..", "assets", "brand", "og-card.jpg")


def make_preview_card():
    img = Image.new("RGB", (W, H), CREAM)
    d = ImageDraw.Draw(img)

    # Checker strip
    sq = 30
    for i in range(W // sq + 1):
        if i % 2 == 0:
            d.rectangle((i * sq, 0, i * sq + sq - 1, sq - 1), fill=RED)

    cx = W / 2
    logo = logo_font(64)
    lw = d.textlength("Today's Dish", font=logo)
    d.text((cx - lw / 2, 38), "Today's Dish", font=logo, fill=RED)
    draw_spaced(d, "ONE MENU · EVERYBODY EATS", font(22, "SemiBold"), cx, 140, INK, 5)

    # Letterboard: wooden frame, felt with grooves
    l, t, r, b = 150, 190, 1050, 600
    d.rounded_rectangle((l, t, r, b), radius=8, fill=FRAME)
    fl, ft, fr, fb = l + 16, t + 16, r - 16, b - 16
    d.rectangle((fl, ft, fr, fb), fill=FELT)
    for y in range(ft + 6, fb, 8):
        d.line((fl, y, fr, y), fill=FELT_LINE, width=2)

    rows = (  # (text, font, colour, tracking, space below)
        ("TODAY'S SPECIALS", font(30, "SemiBold"), GOLD, 8, 34),
        ("WHAT'S ON", font(72, "Bold"), LETTER, 10, 14),
        ("THE MENU TODAY?", font(72, "Bold"), LETTER, 10, 38),
        ("BREAKFAST · LUNCH · DINNER", font(28, "SemiBold"), GOLD, 7, 0),
    )
    heights = [f.getbbox(text)[3] for text, f, *_ in rows]
    total = sum(heights) + sum(row[4] for row in rows)
    y = ft + (fb - ft - total) / 2 - 6
    for (text, f, colour, tracking, gap), h in zip(rows, heights):
        draw_spaced(d, text, f, cx, y, colour, tracking)
        y += h + gap
    return img


if __name__ == "__main__":
    make_preview_card().save(OUT, quality=88, optimize=True, progressive=True)
    print("wrote", os.path.normpath(OUT))
