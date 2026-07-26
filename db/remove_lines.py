from pathlib import Path
import re


def main(file_path: str) -> None:
    path = Path(file_path)
    content = path.read_text(encoding="utf-8")
    content = re.sub(r"(\r?\n){3,}", "\n\n", content)
    path.write_text(content, encoding="utf-8")


if __name__ == "__main__":
    main("db/clone_schema.sql")
