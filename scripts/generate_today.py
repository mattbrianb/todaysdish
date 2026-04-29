import os
import requests
import json
from datetime import date

API_KEY = os.getenv("SPOONACULAR_API_KEY")
BASE_URL = "https://api.spoonacular.com/recipes/random"


def image_exists(url):
    if not url:
        return False
    try:
        r = requests.head(url, timeout=5)
        return r.status_code == 200
    except requests.RequestException:
        return False


def get_recipe_with_image(tags, attempts=3):
    for _ in range(attempts):
        params = {
            "apiKey": API_KEY,
            "number": 5,
            "tags": tags
        }

        response = requests.get(BASE_URL, params=params)
        response.raise_for_status()

        for recipe in response.json()["recipes"]:
            image = recipe.get("image")

            if not image_exists(image):
                continue

            ingredients = [
                item["original"]
                for item in recipe.get("extendedIngredients", [])
            ]

            steps = []
            instructions = recipe.get("analyzedInstructions", [])
            if instructions:
                steps = [s["step"] for s in instructions[0]["steps"]]

            return {
                "name": recipe["title"],
                "image": image,
                "cookTime": recipe.get("readyInMinutes"),
                "ingredients": ingredients,
                "steps": steps
            }

    raise RuntimeError(f"No valid recipe with image found for tags: {tags}")


def main():
    today = {
        "date": str(date.today()),
        "breakfast": get_recipe_with_image("breakfast"),
        "lunch": get_recipe_with_image("main course"),
        "dinner": get_recipe_with_image("dinner")
    }

    with open("today.json", "w") as f:
        json.dump(today, f, indent=2)


if __name__ == "__main__":
    main()
