import os
import random
import requests
import json
from datetime import datetime, timedelta, timezone

API_KEY = os.getenv("SPOONACULAR_API_KEY")
BASE_URL = "https://api.spoonacular.com/recipes/random"

TODAY_FILE = "today.json"
HISTORY_FILE = "history.json"

# Don't serve a dish again within this many days. Spoonacular's breakfast pool is
# small (~200 recipes with images), so a much longer window would force repeats anyway.
NO_REPEAT_DAYS = 90
HISTORY_KEEP_DAYS = 365



def image_exists(url):
    if not url:
        return False
    try:
        r = requests.head(url, timeout=5)
        return r.status_code == 200
    except requests.RequestException:
        return False


def name_key(name):
    return " ".join(str(name).lower().split())


def load_history():
    try:
        with open(HISTORY_FILE, encoding="utf-8") as f:
            return json.load(f).get("served", [])
    except FileNotFoundError:
        return []


def save_history(served, today):
    cutoff = str(today - timedelta(days=HISTORY_KEEP_DAYS))
    served = [e for e in served if e["date"] >= cutoff]
    with open(HISTORY_FILE, "w", encoding="utf-8") as f:
        json.dump({"served": served}, f, indent=2, ensure_ascii=False)


def to_dish(recipe):
    ingredients = [
        item["original"]
        for item in recipe.get("extendedIngredients", [])
    ]

    steps = []
    instructions = recipe.get("analyzedInstructions", [])
    if instructions:
        steps = [s["step"] for s in instructions[0]["steps"]]

    return {
        "id": recipe.get("id"),
        "name": recipe["title"],
        "image": recipe.get("image"),
        "cookTime": recipe.get("readyInMinutes"),
        "ingredients": ingredients,
        "steps": steps
    }


def meal_label(tags):
    return ", ".join(tags) if isinstance(tags, (list, tuple)) else tags


def get_recipe_with_image(tags, last_served, used_today, attempts=4):
    """Pick a recipe not served in the last NO_REPEAT_DAYS (by name or id).

    If every candidate is a recent repeat, fall back to the one served longest ago
    rather than failing the day.
    """
    fallback, fallback_date = None, None
    # Several tags widen the pool: start at a random one and rotate through them
    tag_options = tags if isinstance(tags, (list, tuple)) else [tags]
    start = random.randrange(len(tag_options))

    for attempt in range(attempts):
        params = {
            "apiKey": API_KEY,
            "number": 10,
            "tags": tag_options[(start + attempt) % len(tag_options)]
        }

        response = requests.get(BASE_URL, params=params, timeout=30)
        response.raise_for_status()

        for recipe in response.json()["recipes"]:
            keys = {name_key(recipe.get("title", "")), str(recipe.get("id"))}
            if keys & used_today:
                continue

            if not image_exists(recipe.get("image")):
                continue

            served_on = max((last_served[k] for k in keys if k in last_served), default=None)
            if served_on is None:
                return to_dish(recipe)

            if fallback is None or served_on < fallback_date:
                fallback, fallback_date = recipe, served_on

    if fallback is not None:
        print(f"[{meal_label(tags)}] no fresh recipe found, repeating one last served {fallback_date}")
        return to_dish(fallback)

    raise RuntimeError(f"No valid recipe with image found for tags: {meal_label(tags)}")


def main():
    # The menu changes at 00:00 GMT
    today = datetime.now(timezone.utc).date()

    # Retry runs exit early once today's dishes exist (FORCE=1 regenerates anyway)
    if os.getenv("FORCE") != "1":
        try:
            with open(TODAY_FILE, encoding="utf-8") as f:
                if json.load(f).get("date") == str(today):
                    print(f"{TODAY_FILE} is already for {today}, nothing to do")
                    return
        except (FileNotFoundError, ValueError):
            pass

    # A forced re-run replaces today's picks, so drop them from history first
    served = [e for e in load_history() if e["date"] != str(today)]

    window_start = str(today - timedelta(days=NO_REPEAT_DAYS))
    last_served = {}
    for e in served:
        if e["date"] < window_start:
            continue
        for k in (name_key(e["name"]), str(e.get("id"))):
            if k != "None":
                last_served[k] = max(last_served.get(k, ""), e["date"])

    used_today = set()
    result = {"date": str(today)}
    # Spoonacular files many morning recipes under "brunch" or "morning meal" rather than "breakfast"
    for meal, tags in (("breakfast", ["breakfast", "brunch", "morning meal"]), ("lunch", "main course"), ("dinner", "dinner")):
        dish = get_recipe_with_image(tags, last_served, used_today)
        result[meal] = dish
        used_today |= {name_key(dish["name"]), str(dish["id"])}
        served.append({"date": str(today), "meal": meal, "name": dish["name"], "id": dish["id"]})

    with open(TODAY_FILE, "w") as f:
        json.dump(result, f, indent=2)

    save_history(served, today)


if __name__ == "__main__":
    main()
