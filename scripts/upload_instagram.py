"""Upload today's Instagram slides, story and caption to the Worker, which posts them.

Reads instagram/YYYY-MM-DD/ (from make_instagram.py) and PUTs each file to
WORKER_URL/media/YYYY-MM-DD/<file> with the MEDIA_KEY secret. Does nothing if
MEDIA_KEY isn't set, so the daily job keeps working before Instagram is connected.
"""
import json
import os
import sys

import requests

WORKER_URL = os.getenv("WORKER_URL", "https://todaysdish-ingredients.mattbrianburnett.workers.dev")


def main():
    key = os.getenv("MEDIA_KEY")
    if not key:
        print("MEDIA_KEY not set, skipping Instagram upload")
        return

    with open("today.json", encoding="utf-8") as f:
        day = json.load(f)["date"]
    folder = os.path.join("instagram", day)
    files = sorted(n for n in os.listdir(folder) if n.endswith((".jpg", ".txt")))
    if not any(n.startswith("post-") for n in files):
        sys.exit(f"No slides in {folder}")

    for name in files:
        with open(os.path.join(folder, name), "rb") as f:
            r = requests.put(f"{WORKER_URL}/media/{day}/{name}", data=f.read(),
                             headers={"Authorization": f"Bearer {key}"}, timeout=60)
        if not r.ok:
            sys.exit(f"Upload of {name} failed: {r.status_code} {r.text[:200]}")
        print(f"uploaded {name} ({r.json().get('bytes')} bytes)")


if __name__ == "__main__":
    main()
