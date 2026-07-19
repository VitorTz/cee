from typing import Any
import re
import json


def read_json(path: str) -> Any:
    with open(path, "r") as file:
        return json.load(file)


def is_valid_island_zip_code(zip_code: str) -> bool:
    return re.fullmatch(r"880[0-6][0-9]-[0-9]{3}", zip_code) is not None
