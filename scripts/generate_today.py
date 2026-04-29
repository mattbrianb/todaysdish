import os
import requests
import random
import json
from datetime import date

API_KEY = os.getenv("SPOONACULAR_API_KEY")

BASE_URL = "https://api.spoonacular.com/recipes/random"

def get_recipe(tags):
    params = {
        "apiKey": API_KEY,
        "number": 1,
        "tags": tags
    }

    response = requests.get(BASE_URL, params=params)
    response.raise_for_status()

    recipe = response.json()["recipes"][0]

    return {
        "name": recipe["title"],
        "image": recipe.get("image"),
        "instructions": recipe.get("instructions", "No instructions available.")
    }

def main():
    today = {
        "date": str(date.today()),
        "breakfast": get_recipe("breakfast"),
        "lunch": get_recipe("main course"),
        "dinner": get_recipe("dinner")
    }

    with open("today.json", "w") as f:
        json.dump(today, f, indent=2)

if __name__ == "__main__":
    main()
