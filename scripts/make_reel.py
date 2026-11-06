"""Draw today's Instagram Reel: a 12 second letterboard reveal of the three dishes.

Writes to instagram/YYYY-MM-DD/:
  reel.mp4          720x1280, 30 fps, H.264 + AAC, kept under 1.8 MB (the Worker stores
                    media in D1, which caps a value at 2 MB)
  reel-caption.txt  a short caption for the Reel

Reels reach people who don't follow the account yet, which carousels mostly don't.
The music is the owner's own track (assets/audio/reel-music.mp3, a clip starting on the
drop). It runs at 120 bpm, so every scene change lands on a bar line (one bar = 2 seconds).

Usage: python scripts/make_reel.py [out_dir]   (needs: pip install imageio-ffmpeg)
"""
import os
import random
import subprocess
import sys
from datetime import date

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageOps

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from make_instagram import (  # noqa: E402
    LAUNCH, MUTED, SITE, TAGS, TREND_TAG, big_photo_url, board, centered, checker, menu_rows,
    nice_time, paste_photo, pill, rotate,
)
from make_share_card import (  # noqa: E402
    CREAM, FELT, GOLD, INK, LETTER, MEALS, RED, draw_spaced, fit_lines, font, logo_font,
    short_name, spaced_width,
)

W, H = 1080, 1920          # drawn at story size, then scaled down for a small file
OUT_W, OUT_H = 720, 1280
FPS = 30
INTRO, DISH, OUTRO = 2.0, 2.0, 4.0   # seconds: one bar each at 120 bpm, two for the sign-off
END_CARD_AT = 2.0                    # seconds into the sign-off: the last bar is the address alone
LETTER_EVERY = 2                     # frames between letters on the board
MUSIC = os.getenv("REEL_MUSIC") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "assets", "audio", "reel-music.mp3")
MUSIC_START = float(os.getenv("REEL_MUSIC_START", "0"))   # seconds into MUSIC
MAX_BYTES = 1_800_000
TEMPLATE = os.getenv("REEL_TEMPLATE", "bold")


def ease_out(t):
    t = min(max(t, 0.0), 1.0)
    return 1 - (1 - t) ** 3


def draw_partial(d, text, f, cx, y, fill, spacing, n):
    """Draw the first n letters of text where they sit in the full, centred line."""
    x = cx - spaced_width(d, text, f, spacing) / 2
    for ch in text[:n]:
        d.text((x, y), ch, font=f, fill=fill)
        x += d.textlength(ch, font=f) + spacing


def letters(text):
    return sum(1 for ch in text if not ch.isspace())


def shown(text, k):
    """How many characters to draw so that k non-space letters are visible."""
    seen = 0
    for i, ch in enumerate(text):
        if not ch.isspace():
            if seen == k:
                return i
            seen += 1
    return len(text)


def base_frame():
    img = Image.new("RGB", (W, H), CREAM)
    d = ImageDraw.Draw(img)
    checker(d, 0, W)
    checker(d, H - 40, W)
    return img


class Reel:
    def __init__(self, data):
        self.data = data
        self.day = date.fromisoformat(data["date"])
        self.dishes = [(k, label, data[k]) for k, label in MEALS if data.get(k)]
        # Photos once, a little larger than shown so they can zoom slowly
        self.photos = {}
        for key, _, dish in self.dishes:
            ph = Image.new("RGB", (1040, 760), FELT)
            paste_photo(ph, dish.get("image"), (0, 0, 1040, 760), radius=28)
            self.photos[key] = ph

    # ---- scenes -------------------------------------------------------------
    def intro(self, t, frame_no):
        img = base_frame()
        d = ImageDraw.Draw(img)
        a = ease_out(t / 0.4)
        centered(d, "Today's Dish", logo_font(120), W / 2, 260 - 60 * (1 - a), RED)
        draw_spaced(d, "ONE MENU · EVERYBODY EATS", font(36, "Bold"), W / 2, 490, INK, 7)
        board(d, (70, 600, W - 70, 1260), [])
        lines = [("WHAT'S ON", font(96, "Bold"), LETTER), ("TODAY'S MENU?", font(96, "Bold"), LETTER)]
        date_line = self.day.strftime("%A · %d · %B").upper().replace(" 0", " ")
        k = max(0, (frame_no - int(0.3 * FPS)) // LETTER_EVERY)
        y = 760
        for text, f, colour in lines:
            n = letters(text)
            draw_partial(d, text, f, W / 2, y, colour, 8, shown(text, max(0, min(k, n))))
            k -= n
            y += 150
        if k > 0:
            draw_spaced(d, date_line, font(40, "Bold"), W / 2, y + 20, GOLD, 7)
        return img

    def dish(self, t, i):
        key, label, dish = self.dishes[i]
        img = base_frame()
        d = ImageDraw.Draw(img)
        pill(d, f"{i + 1}  ·  {label.upper()}", font(44, "Bold"), W / 2, 230, FELT, GOLD, pad=(36, 18))
        # Photo rises in, then zooms slowly
        a = ease_out(t / 0.35)
        zoom = 1.0 + 0.06 * (t / DISH)
        ph = self.photos[key]
        cw, ch = int(960 / zoom), int(700 / zoom)
        left, top = (1040 - cw) // 2, (760 - ch) // 2
        crop = ph.crop((left, top, left + cw, top + ch)).resize((960, 700), Image.LANCZOS)
        mask = Image.new("L", (960, 700), 0)
        ImageDraw.Draw(mask).rounded_rectangle((0, 0, 959, 699), radius=28, fill=255)
        img.paste(crop, (60, int(380 + 70 * (1 - a))), mask)
        # Dish name on a felt strip, letter by letter
        name = short_name(dish["name"]).upper()
        f, lines = fit_lines(d, name, W - 200, (78, 70, 62, 56, 50), 3)
        strip_h = len(lines) * (f.size + 16) + 70
        d.rounded_rectangle((70, 1120, W - 70, 1120 + strip_h), radius=10, fill=FELT)
        # Long names type faster so every name is complete within a second
        total = sum(letters(line) for line in lines)
        k = max(0, int((t - 0.35) * FPS * max(1 / LETTER_EVERY, total / FPS)))
        y = 1155
        for line in lines:
            n = letters(line)
            draw_partial(d, line, font(f.size, "Bold"), W / 2, y, LETTER, 4, shown(line, max(0, min(k, n))))
            k -= n
            y += f.size + 16
        if dish.get("cookTime") and k > 0:
            centered(d, "Ready in " + nice_time(dish["cookTime"]), font(46, "Bold"), W / 2, 1150 + strip_h, MUTED)
        return img

    def outro(self, t):
        """The full menu with the call to action for a bar, then a clean end card with the address."""
        if t >= END_CARD_AT:
            return self.end_card(t - END_CARD_AT)
        img = base_frame()
        d = ImageDraw.Draw(img)
        centered(d, "Today's Dish", logo_font(110), W / 2, 200, RED)
        board(d, (70, 420, W - 70, 1120), menu_rows(d, self.data, W - 260, 1.08))
        a = ease_out((t - 0.3) / 0.5)
        if a > 0:
            y = 1180 + 30 * (1 - a)
            centered(d, "Eating one today?", font(52, "Bold"), W / 2, y, INK)
            pill(d, "TAP I'M EATING THIS", font(48, "Bold"), W / 2, y + 86, RED, (255, 255, 255), pad=(44, 24), tracking=5)
        return img

    def end_card(self, t):
        # The menu fades to plain cream, then the address fades in, so the two never overlap
        out, fade_in = 0.15, 0.3
        if t < out:
            return Image.blend(self.outro(END_CARD_AT - 0.01), base_frame(), t / out)
        a = ease_out((t - out) / fade_in)
        img = base_frame()
        d = ImageDraw.Draw(img)
        y = 700 + 30 * (1 - a)
        centered(d, "Today's Dish", logo_font(120), W / 2, y, RED)
        draw_spaced(d, "ONE MENU · EVERYBODY EATS", font(34, "Bold"), W / 2, y + 230, INK, 7)
        centered(d, "www." + SITE, font(80, "Bold"), W / 2, y + 340, RED)
        return img if a >= 1 else Image.blend(base_frame(), img, a)

    # ---- timeline -----------------------------------------------------------
    def seconds(self):
        return INTRO + DISH * len(self.dishes) + OUTRO

    def frames(self):
        for n in range(int(self.seconds() * FPS)):
            t = n / FPS
            if t < INTRO:
                img = self.intro(t, n)
            elif t < INTRO + DISH * len(self.dishes):
                i = int((t - INTRO) // DISH)
                img = self.dish(t - INTRO - i * DISH, i)
            else:
                img = self.outro(t - INTRO - DISH * len(self.dishes))
            yield img.resize((OUT_W, OUT_H), Image.LANCZOS)


# ---- Full-screen photo templates ---------------------------------------------
# The recipe photos are small landscape shots (636x393), so a photo is shown at full width,
# sharp, over a blurred, darkened copy of itself that fills the tall frame. Each template
# draws its own title in the middle; intro, outro and end card are shared with the brand.

def fetch_raw(url):
    import io
    import requests
    for u in (big_photo_url(url), url):
        try:
            r = requests.get(u, timeout=15)
            r.raise_for_status()
            return Image.open(io.BytesIO(r.content)).convert("RGB")
        except Exception:
            continue
    return Image.new("RGB", (636, 393), FELT)


def smooth(t):
    """Smooth start and finish (ease in-out), clamped to 0..1."""
    t = min(max(t, 0.0), 1.0)
    return t * t * t * (t * (t * 6 - 15) + 10)


def ease_back(t):
    """Overshoots a little, then settles: a pop."""
    t = min(max(t, 0.0), 1.0)
    c = 1.7
    return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2


PHOTO_H = 1150   # height of the sharp photo band in the 1920-tall frame


class PhotoReel(Reel):
    DIM = 0.35   # how much the whole frame is darkened behind the title

    def __init__(self, data):
        super().__init__(data)
        self.bg = {}
        for key, _, dish in self.dishes:
            raw = fetch_raw(dish.get("image"))
            blur = ImageOps.fit(raw, (W // 6, H // 6)).filter(ImageFilter.GaussianBlur(3)).resize((W, H), Image.BICUBIC)
            blur = ImageEnhance.Brightness(blur).enhance(0.55)
            # The sharp photo fills about 60% of the height (sides cropped), edges fading into the blur
            ph = PHOTO_H
            sharp = ImageOps.fit(raw, (W, ph), Image.LANCZOS, centering=(0.5, 0.5)) if raw.width / raw.height < W / ph                 else raw.resize((int(raw.width * ph / raw.height), ph), Image.LANCZOS)
            sharp = sharp.crop(((sharp.width - W) // 2, 0, (sharp.width - W) // 2 + W, ph))
            self.bg[key] = (blur, sharp)
        fade = 90
        self.mask = Image.new("L", (W, PHOTO_H), 255)
        md = ImageDraw.Draw(self.mask)
        for y in range(fade):
            v = int(255 * y / fade)
            md.line((0, y, W, y), fill=v)
            md.line((0, PHOTO_H - 1 - y, W, PHOTO_H - 1 - y), fill=v)

    def background(self, key, t, length):
        blur, sharp = self.bg[key]
        img = blur.copy()
        zoom = 1.0 + 0.08 * min(t / length, 1.0)
        cw, ch = int(W / zoom), int(PHOTO_H / zoom)
        crop = sharp.crop(((W - cw) // 2, (PHOTO_H - ch) // 2, (W - cw) // 2 + cw, (PHOTO_H - ch) // 2 + ch))
        img.paste(crop.resize((W, PHOTO_H), Image.BILINEAR), (0, (H - PHOTO_H) // 2), self.mask)
        if self.DIM:
            img = Image.blend(img, Image.new("RGB", (W, H), (0, 0, 0)), self.DIM)
        return img

    def intro(self, t, frame_no):
        img = self.background(self.dishes[0][0], t, INTRO)
        date_line = self.day.strftime("%A %d %B").replace(" 0", " ")
        self.title(img, t, "TODAY'S DISH", "WHAT'S ON TODAY'S MENU?", date_line)
        return img

    def dish(self, t, i):
        key, label, dish = self.dishes[i]
        img = self.background(key, t, DISH)
        extra = "Ready in " + nice_time(dish["cookTime"]) if dish.get("cookTime") else ""
        self.title(img, t, f"{i + 1}  ·  {label.upper()}", short_name(dish["name"]), extra)
        return img

    def lines(self, d, text, sizes, width, weight="Bold", tracking=4):
        f, lines = fit_lines(d, text.upper(), width, sizes, tracking)
        return font(f.size, weight), lines


class LetterboardOverPhoto(PhotoReel):
    """1. The diner letterboard strip, typed letter by letter, over the photo."""
    DIM = 0.25

    def title(self, img, t, kicker, name, extra):
        d = ImageDraw.Draw(img)
        f, lines = self.lines(d, name, (84, 76, 68, 60, 54), W - 220)
        line_h = f.size + 18
        strip_h = len(lines) * line_h + 80
        top = H // 2 - strip_h // 2
        pill(d, kicker, font(42, "Bold"), W / 2, top - 110, FELT, GOLD, pad=(34, 18))
        d.rounded_rectangle((60, top, W - 60, top + strip_h), radius=12, fill=(139, 90, 53))
        d.rectangle((76, top + 16, W - 76, top + strip_h - 16), fill=FELT)
        total = sum(letters(line) for line in lines)
        k = max(0, int((t - 0.2) * FPS * max(1 / LETTER_EVERY, total / FPS)))
        y = top + 40
        for line in lines:
            n = letters(line)
            draw_partial(d, line, f, W / 2, y, LETTER, 4, shown(line, max(0, min(k, n))))
            k -= n
            y += line_h
        if extra and k > 0:
            pill(d, extra.upper(), font(36, "Bold"), W / 2, top + strip_h + 34, (0, 0, 0), (255, 255, 255), pad=(30, 14))


class BoldPoster(PhotoReel):
    """2. Huge white words that rise in one at a time, magazine-cover style."""
    DIM = 0.45

    def title(self, img, t, kicker, name, extra):
        """Label, then the words one after another, then the detail line: each fades and glides
        up over half a second, and everything fades out just before the cut."""
        d = ImageDraw.Draw(img)
        f, lines = self.lines(d, name, (128, 112, 100, 88, 78), W - 140, tracking=0)
        line_h = int(f.size * 1.08)
        block = len(lines) * line_h
        top = H // 2 - block // 2
        exit_ = smooth((DISH - t) / 0.25)            # 1 until the last quarter second, then to 0
        lift = 12 * (1 - exit_)

        def appear(start, dur=0.5):
            return smooth((t - start) / dur) * exit_

        text = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        shade = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        td, sd = ImageDraw.Draw(text), ImageDraw.Draw(shade)

        a = appear(0.0, 0.45)
        if a > 0:
            kf = font(40, "Bold")
            y = top - 90 + 18 * (1 - a) - lift
            draw_spaced(td, kicker, kf, W / 2, y, GOLD + (int(255 * a),), 8)

        n = 0
        for li, line in enumerate(lines):
            x = W / 2 - d.textlength(line, font=f) / 2
            for word in line.split():
                a = appear(0.12 + 0.07 * n)
                if a > 0:
                    y = top + li * line_h + 28 * (1 - a) - lift
                    sd.text((x + 3, y + 6), word, font=f, fill=(0, 0, 0, int(200 * a)))
                    td.text((x, y), word, font=f, fill=(255, 255, 255, int(255 * a)))
                x += d.textlength(word + " ", font=f)
                n += 1

        if extra:
            a = appear(0.12 + 0.07 * n + 0.1, 0.45)
            if a > 0:
                ef = font(40, "Bold")
                y = top + block + 40 + 16 * (1 - a) - lift
                td.text((W / 2 - d.textlength(extra.upper(), font=ef) / 2, y), extra.upper(), font=ef, fill=GOLD + (int(255 * a),))

        shade = shade.filter(ImageFilter.GaussianBlur(8))
        img.paste(shade, (0, 0), shade)
        img.paste(text, (0, 0), text)


class MenuCard(PhotoReel):
    """3. A cream menu card pops up in the middle with the dish name in brand colours."""
    DIM = 0.2

    def title(self, img, t, kicker, name, extra):
        tmp = ImageDraw.Draw(img)
        f, lines = self.lines(tmp, name, (72, 64, 58, 52, 46), W - 280)
        line_h = f.size + 14
        cw = W - 160
        ch = 150 + len(lines) * line_h + (80 if extra else 30)
        card = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
        cd = ImageDraw.Draw(card)
        cd.rounded_rectangle((0, 0, cw - 1, ch - 1), radius=36, fill=CREAM + (255,), outline=RED + (255,), width=6)
        label = kicker.split("·")[-1].strip().title() if "·" in kicker else "Today's Dish"
        lf = logo_font(64)
        cd.text((cw / 2 - cd.textlength(label, font=lf) / 2, 18), label, font=lf, fill=RED)
        y = 140
        for line in lines:
            draw_spaced(cd, line, f, cw / 2, y, INK, 3)
            y += line_h
        if extra:
            ef = font(38, "Bold")
            cd.text((cw / 2 - cd.textlength(extra, font=ef) / 2, y + 16), extra, font=ef, fill=MUTED)
        scale = max(0.01, ease_back(t / 0.45))
        if scale != 1:
            card = card.resize((max(1, int(cw * scale)), max(1, int(ch * scale))), Image.BILINEAR)
        img.paste(card, ((W - card.width) // 2, (H - card.height) // 2), card)


class StickerLines(PhotoReel):
    """4. Each line of the name on its own red sticker bar, sliding in from alternate sides."""
    DIM = 0.15

    def title(self, img, t, kicker, name, extra):
        d = ImageDraw.Draw(img)
        f, lines = self.lines(d, name, (84, 76, 68, 60, 54), W - 200, tracking=0)
        line_h = f.size + 40
        top = H // 2 - (len(lines) * line_h) // 2
        kf = font(38, "Bold")
        kw = d.textlength(kicker, font=kf)
        d.rounded_rectangle((W / 2 - kw / 2 - 26, top - 100, W / 2 + kw / 2 + 26, top - 34), radius=12, fill=(0, 0, 0))
        d.text((W / 2 - kw / 2, top - 88), kicker, font=kf, fill=(255, 255, 255))
        for i, line in enumerate(lines):
            a = ease_out((t - 0.1 - 0.15 * i) / 0.35)
            if a <= 0:
                continue
            tw = d.textlength(line, font=f)
            side = -1 if i % 2 == 0 else 1
            x = W / 2 - tw / 2 + side * (1 - a) * W
            y = top + i * line_h
            d.rectangle((x - 26, y - 8, x + tw + 26, y + f.size + 22), fill=RED)
            d.text((x, y), line, font=f, fill=(255, 255, 255))
        if extra and t > 0.8:
            ef = font(38, "Bold")
            ew = d.textlength(extra, font=ef)
            y = top + len(lines) * line_h + 20
            d.rectangle((W / 2 - ew / 2 - 20, y - 6, W / 2 + ew / 2 + 20, y + 54), fill=CREAM)
            d.text((W / 2 - ew / 2, y), extra, font=ef, fill=INK)


class Cinematic(PhotoReel):
    """5. Film-style black bars, thin gold rules and a wide-spaced title that tightens as it fades in."""
    DIM = 0.3

    def title(self, img, t, kicker, name, extra):
        d = ImageDraw.Draw(img)
        bar = 230
        d.rectangle((0, 0, W, bar), fill=(0, 0, 0))
        d.rectangle((0, H - bar, W, H), fill=(0, 0, 0))
        a = ease_out((t - 0.1) / 0.6)
        tracking = int(6 + 24 * (1 - a))
        f, lines = self.lines(d, name, (76, 68, 60, 54, 48), W - 220, weight="Medium", tracking=tracking)
        line_h = f.size + 20
        block = len(lines) * line_h
        top = H // 2 - block // 2
        layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        ld = ImageDraw.Draw(layer)
        alpha = int(255 * a)
        draw_spaced(ld, kicker, font(34, "Bold"), W / 2, top - 110, GOLD + (alpha,), 10)
        rule = int(260 * a)
        ld.line((W / 2 - rule, top - 40, W / 2 + rule, top - 40), fill=GOLD + (alpha,), width=3)
        for i, line in enumerate(lines):
            draw_spaced(ld, line, f, W / 2, top + i * line_h, (255, 255, 255, alpha), tracking)
        ld.line((W / 2 - rule, top + block + 10, W / 2 + rule, top + block + 10), fill=GOLD + (alpha,), width=3)
        if extra:
            draw_spaced(ld, extra.upper(), font(32, "Bold"), W / 2, top + block + 40, (230, 230, 230, alpha), 6)
        img.paste(layer, (0, 0), layer)


TEMPLATES = {
    "letterboard": Reel,
    "photo-letterboard": LetterboardOverPhoto,
    "bold": BoldPoster,
    "card": MenuCard,
    "sticker": StickerLines,
    "cinematic": Cinematic,
}


def encode(reel, path, bitrate_k):
    import imageio_ffmpeg
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    silent = path + ".video.mp4"
    p = subprocess.Popen(
        [ffmpeg, "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24",
         "-s", f"{OUT_W}x{OUT_H}", "-r", str(FPS), "-i", "-",
         "-c:v", "libx264", "-preset", "slow", "-profile:v", "high", "-pix_fmt", "yuv420p",
         "-b:v", f"{bitrate_k}k", "-maxrate", f"{int(bitrate_k * 1.3)}k", "-bufsize", f"{bitrate_k * 2}k",
         silent],
        stdin=subprocess.PIPE)
    for frame in reel.frames():
        p.stdin.write(frame.tobytes())
    p.stdin.close()
    if p.wait() != 0:
        raise RuntimeError("ffmpeg failed to encode the video")
    seconds = reel.seconds()
    subprocess.run(
        [ffmpeg, "-y", "-loglevel", "error", "-i", silent, "-ss", str(MUSIC_START), "-i", MUSIC,
         "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-t", str(seconds),
         "-af", f"afade=t=out:st={seconds - 1.2}:d=1.2", "-c:a", "aac", "-b:a", "96k", "-ar", "44100",
         "-movflags", "+faststart", path],
        check=True)
    os.remove(silent)
    return os.path.getsize(path)


def reel_caption(data):
    day = date.fromisoformat(data["date"])
    day_no = (day - LAUNCH).days + 1
    rng = random.Random(data["date"] + "reel")
    hooks = [
        "Everyone's eating this today 👀",
        "Today's menu, decided for you 🍽️",
        "POV: you never have to ask \"what's for dinner?\" again",
        "Breakfast, lunch and dinner in 12 seconds ⏱️",
        "One menu. Everybody eats. Here's today's 🍽️",
        "Would you eat all three today? 👇",
    ]
    lines = [rotate(hooks, day_no, "reel-hook"), ""]
    for key, label in MEALS:
        if data.get(key):
            lines.append(f"{label}: {short_name(data[key]['name'])}")
    lines += ["", "Full recipes and the \"I'm eating this\" button at todaysdish.food (link in bio)",
              "New menu every day. Follow so you never miss one 🔔", "",
              " ".join([TREND_TAG, "#reels", "#foodreels"] + rng.sample(TAGS, 3))]
    return "\n".join(lines) + "\n"


def main():
    import json
    with open("today.json", encoding="utf-8") as f:
        data = json.load(f)
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join("instagram", data["date"])
    os.makedirs(out, exist_ok=True)
    path = os.path.join(out, "reel.mp4")
    for kbps in (1100, 850, 650):
        size = encode(TEMPLATES[TEMPLATE](data), path, kbps)
        if size <= MAX_BYTES:
            break
    else:
        os.remove(path)
        sys.exit(f"Reel stayed over {MAX_BYTES} bytes, skipping it today")
    with open(os.path.join(out, "reel-caption.txt"), "w", encoding="utf-8") as f:
        f.write(reel_caption(data))
    print(f"wrote reel.mp4 ({size:,} bytes) and reel-caption.txt to {out}")


if __name__ == "__main__":
    main()
