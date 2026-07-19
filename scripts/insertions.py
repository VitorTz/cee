from dotenv import load_dotenv
from psycopg.rows import dict_row
import util
import json
import psycopg
import os


def main() -> None:
    load_dotenv()
    db_url: str = os.getenv("DATABASE_URL", "")
    conn = psycopg.connect(db_url)
    cur = conn.cursor()
    cur.row_factory = dict_row
    data: dict[str, int] = {}
    cur.execute(
        """
            SELECT
                id,
                name
            FROM
                streets
        """
    )
    rows = cur.fetchall()
    for row in rows:
        data[row["name"]] = row["id"]

    values: set[str] = set()

    raw_data: dict[str, list[dict[str, str]]] = util.read_json("data.json")
    for v in raw_data.values():
        for row in v:
            street_id: int = data[row["logradouro"]]
            cep: str = row["cep"]
            if not util.is_valid_island_zip_code(cep):
                continue
            values.add(f"({street_id}, '{cep}')")

    query = f"""INSERT INTO zip_codes (street_id, zip_code) VALUES
        {",\n\t".join(sorted(values, key=lambda value: int(value[1 : value.index(",")])))}
    ON CONFLICT (street_id, zip_code) DO NOTHING;
    """

    cur.execute(query)
    conn.commit()

    with open("zip_insertions.sql", "w+") as file:
        file.write(query)

    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
