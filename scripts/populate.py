from dbfread import DBF
from pathlib import Path
import psycopg
from urllib.parse import quote
import json
import time
import requests
import re


ERROS = []


def read_json(path: Path | str, _default=None):
    try:
        with open(path, "r", encoding="utf-8") as file:
            return json.load(file)
    except Exception:
        return {} if not _default else _default


def save_json(obj, path: Path | str):
    with open(path, "w+") as file:
        json.dump(obj, file, indent=4, sort_keys=True)


def extract_unique_streets(file_path) -> list[str]:
    """
    Reads the municipality DBF file and extracts a clean, unique list of streets.
    Uses 'latin1' encoding to correctly handle Brazilian Portuguese characters (Ç, Ã, Á).
    """

    def normalize_string(value: str) -> str:
        return " ".join(re.sub(r"\s*\(\d+\)\s*$", "", value).strip().title().split())

    try:
        table = DBF(file_path, encoding="latin1")
        unique_streets = set()

        for record in table:
            nome: str = record.get("nome", "").strip()
            if nome:
                unique_streets.add(normalize_string(nome))

        print(f"Extraction complete! Found {len(unique_streets)} unique streets.")

        return list(unique_streets)
    except Exception as e:
        print(f"Error reading DBF: {e}")
        return []


def fetch_zip_code_by_street(
    street_name, city="Florianopolis", state="SC"
) -> list[dict]:
    """
    Queries the free ViaCEP API to find the ZIP code based on street and city.
    The endpoint format is: viacep.com.br/ws/UF/City/StreetName/json/
    """

    def sanitize_street_name(street_name):
        clean_name = re.sub(r"\(.*?\)", "", street_name)
        clean_name = re.sub(r"(?i)^(avenida|servid[ãa]o|rua)\s+", "", clean_name)
        return clean_name.strip()

    # ViaCEP requires the street search string to be at least 3 characters long
    if len(street_name) < 3:
        print(f"Street name '{street_name}' is too short for search.")
        return []

    time.sleep(0.5)
    street_name = sanitize_street_name(street_name)
    # Encode the street name to handle spaces and special characters safely in the URL
    encoded_street = quote(street_name)
    url = f"https://viacep.com.br/ws/{state}/{city}/{encoded_street}/json/"

    try:
        response = requests.get(url)
        response.raise_for_status()

        # This endpoint returns a list of matching addresses, not just a single object
        data = response.json()
        results: list[dict] = []
        try:
            for row in data:
                results.append(
                    {
                        "cep": row["cep"],
                        "logradouro": row["logradouro"],
                        "bairro": row["bairro"],
                    }
                )
        except Exception as e:
            print(f"[ERRO]: {street_name}: {e}")
            ERROS.append(f"{street_name}: {e}")
        return results
    except requests.exceptions.RequestException as e:
        print(f"API request failed for {street_name}: {e}")
        return []


def create_insertion_query():
    path = Path("data.json")
    data: dict = read_json(path)
    values: set[str] = set()

    query_data: dict[str, set[str]] = {}

    for v in data.values():
        for street in v:
            name = street["logradouro"].replace("'", "''")
            neighborhoods = query_data.get(name, set())
            neighborhoods.add(f"'{street['bairro'].replace("'", "''")}'")
            query_data[name] = neighborhoods

    for k, v in query_data.items():
        values.add(f"('{k}', ARRAY[{', '.join(v)}])")

    query = f"""INSERT INTO streets (
    name, 
    neighborhood
) 
VALUES
        {",\n\t".join(sorted(list(values)))}
ON CONFLICT 
    (name) 
DO NOTHING;
    """

    with open("insertions.sql", "w+") as file:
        file.write(query)


def main() -> None:
    path = Path("data.json")
    data: dict = read_json(path)
    ERROS = read_json("erros.json", [])

    streets: list[str] = extract_unique_streets("gvw_trechos_logradouro.dbf")
    count = 0
    for street in streets:
        if street in data:
            print(f"{street} already in data")
            continue
        zip_codes: list[dict] = fetch_zip_code_by_street(street)
        if zip_codes:
            data[street] = zip_codes
            count += 1
            print(f"{street}: {zip_codes[0]['cep']}")

        if count % 10 == 0:
            save_json(data, path)
            count = 0

    save_json(data, path)
    save_json(list(set(ERROS)), "erros.json")


if __name__ == "__main__":
    create_insertion_query()
