#!/usr/bin/env python3
"""Create a deterministic .skill ZIP from a staged canonical skill tree."""

from __future__ import annotations

import sys
import zipfile
from pathlib import Path


def package_skill(skill_root: Path, archive_path: Path) -> None:
    if not skill_root.is_dir():
        raise ValueError(f"skill root is not a directory: {skill_root}")
    files = sorted(path for path in skill_root.rglob("*") if path.is_file())
    if not files:
        raise ValueError("skill tree is empty")
    archive_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = archive_path.with_name(f".{archive_path.name}.tmp")
    try:
        with zipfile.ZipFile(
            temporary_path,
            "w",
            compression=zipfile.ZIP_DEFLATED,
            compresslevel=9,
        ) as archive:
            for path in files:
                relative = path.relative_to(skill_root.parent).as_posix()
                entry = zipfile.ZipInfo(relative, date_time=(1980, 1, 1, 0, 0, 0))
                entry.compress_type = zipfile.ZIP_DEFLATED
                entry.create_system = 3
                entry.external_attr = 0o100644 << 16
                archive.writestr(
                    entry,
                    path.read_bytes(),
                    compress_type=zipfile.ZIP_DEFLATED,
                    compresslevel=9,
                )
        temporary_path.replace(archive_path)
    finally:
        temporary_path.unlink(missing_ok=True)


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: package-skill.py <staged-skill-root> <archive.skill>")
    package_skill(Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve())


if __name__ == "__main__":
    main()
