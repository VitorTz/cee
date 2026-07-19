import requests
import json

# Overpass API endpoint
OVERPASS_URL = "http://overpass-api.de/api/interpreter"

# Query to fetch all ways (streets) with a name in Florianopolis
OVERPASS_QUERY = """
[out:json];
area(3600298155)->.searchArea;
way["highway"]["name"](area.searchArea);
out tags;
"""


def fetch_florianopolis_streets():
    """Fetches street data from OpenStreetMap and saves it to a JSON file."""

    # Overpass API strictly requires a User-Agent header to prevent abuse.
    # It is good practice to include a descriptive name or contact info.
    headers = {"User-Agent": "FloripaCEE_DatabaseBuilder/1.0 (your_email@example.com)"}

    try:
        # Pass the query inside the 'data' parameter and include the headers
        response = requests.post(
            OVERPASS_URL, data={"data": OVERPASS_QUERY}, headers=headers
        )
        response.raise_for_status()

        data = response.json()
        streets = set()

        # Extract unique street names
        for element in data.get("elements", []):
            tags = element.get("tags", {})
            street_name = tags.get("name")
            if street_name:
                streets.add(street_name)

        # Save the unique streets to a JSON file
        with open("florianopolis_streets.json", "w", encoding="utf-8") as file:
            json.dump(sorted(list(streets)), file, ensure_ascii=False, indent=4)

        print(
            f"Successfully saved {len(streets)} streets to florianopolis_streets.json"
        )

    except requests.exceptions.RequestException as e:
        print(f"Error fetching data from Overpass API: {e}")


if __name__ == "__main__":
    fetch_florianopolis_streets()
