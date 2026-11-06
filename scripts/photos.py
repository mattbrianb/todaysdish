"""Recipe photos, sharpened for full-size posts.

The recipe photos are small (about 600x400). Before one fills a 1080x1350 post it is
enlarged 4x with Real-ESRGAN (assets/models, run by onnxruntime on the CPU, about 5 s a
photo), which rebuilds clean edges instead of a blurry stretch. Results are cached in
instagram/.cache so the carousel and the Reel share them. If the model or onnxruntime
isn't available the plain photo is used, so posting never depends on it.
"""
import hashlib
import io
import os

import requests
from PIL import Image

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
MODEL = os.path.join(ROOT, "assets", "models", "realesr-general-x4v3.onnx")
CACHE = os.path.join(ROOT, "instagram", ".cache")
FALLBACK = (29, 29, 29)
_session = None


def big_photo_url(url):
    import re
    # Spoonacular serves larger copies of the same photo; 636x393 is the biggest
    return re.sub(r"-\d+x\d+\.(jpg|png)$", r"-636x393.\1", url or "")


def fetch(url):
    """The largest copy of a recipe photo, or None if it can't be loaded."""
    for u in (big_photo_url(url), url):
        if not u:
            continue
        try:
            r = requests.get(u, timeout=15)
            r.raise_for_status()
            return Image.open(io.BytesIO(r.content)).convert("RGB")
        except Exception:
            continue
    return None


def _upscale(img):
    global _session
    import numpy as np
    import onnxruntime as ort
    if _session is None:
        _session = ort.InferenceSession(MODEL, providers=["CPUExecutionProvider"])
    x = np.asarray(img, dtype=np.float32).transpose(2, 0, 1)[None] / 255.0
    y = _session.run(None, {"input": x})[0][0]
    return Image.fromarray((np.clip(y, 0, 1).transpose(1, 2, 0) * 255).round().astype("uint8"))


def sharp(url):
    """The recipe photo enlarged 4x and sharpened (cached), else the plain photo."""
    key = hashlib.sha1((url or "").encode()).hexdigest()[:16]
    path = os.path.join(CACHE, key + ".png")
    if os.path.exists(path):
        return Image.open(path).convert("RGB")
    img = fetch(url)
    if img is None:
        return Image.new("RGB", (636, 393), FALLBACK)
    try:
        img = _upscale(img)
        os.makedirs(CACHE, exist_ok=True)
        img.save(path)
    except Exception as e:
        print(f"photo sharpening skipped ({e}); using the original photo")
    return img
