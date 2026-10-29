"""Very small file-based layout store (one JSON file per layout).

Deliberately simple: in the Docker/Kubernetes steps this directory becomes a
volume / PersistentVolumeClaim, which is a good first contact with state in
containers. A database can replace it later behind the same interface.
"""

import json
import re
from pathlib import Path

from .models import Layout

NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


class InvalidName(ValueError):
    pass


class LayoutStore:
    def __init__(self, directory: Path):
        self.directory = directory
        self.directory.mkdir(parents=True, exist_ok=True)

    def _path(self, name: str) -> Path:
        if not NAME_RE.match(name):
            raise InvalidName("Names may only contain letters, digits, '-' and '_' (max 64).")
        return self.directory / f"{name}.json"

    def list(self) -> list[str]:
        return sorted(p.stem for p in self.directory.glob("*.json"))

    def get(self, name: str) -> Layout | None:
        path = self._path(name)
        if not path.exists():
            return None
        return Layout.model_validate_json(path.read_text(encoding="utf-8"))

    def put(self, name: str, layout: Layout) -> None:
        path = self._path(name)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(layout.model_dump(), indent=2), encoding="utf-8")
        tmp.replace(path)

    def delete(self, name: str) -> bool:
        path = self._path(name)
        if not path.exists():
            return False
        path.unlink()
        return True
