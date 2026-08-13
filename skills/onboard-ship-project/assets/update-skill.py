#!/usr/bin/env python3
"""Update an installed Ship contributor skill from its canonical package."""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
import urllib.request
import uuid
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any, Callable

PUBLIC_ORIGIN = "https://ship.freecodefund.xyz"
SHIP_REPOSITORY = "freecodexyz/ship"
ID = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
REVISION = re.compile(r"^[0-9a-f]{40}$")
MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024
MAX_FILES = 33
MAX_FILE_BYTES = 4 * 1024 * 1024
MAX_TREE_BYTES = 16 * 1024 * 1024
Fetch = Callable[[str, int], bytes]


class UpdateError(RuntimeError):
    pass


def record(value: Any, keys: set[str], context: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != keys:
        raise UpdateError(f"{context} has an unexpected schema")
    return value


def text(value: Any, context: str) -> str:
    if not isinstance(value, str) or not value or value.strip() != value:
        raise UpdateError(f"{context} must be non-empty trimmed text")
    return value


def sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def parse_json(value: bytes, context: str) -> Any:
    try:
        return json.loads(value.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise UpdateError(f"{context} is not valid UTF-8 JSON") from error


def fetch_url(url: str, limit: int) -> bytes:
    request = urllib.request.Request(
        url,
        headers={"Accept": "application/json, application/octet-stream", "Cache-Control": "no-cache"},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            length = response.headers.get("Content-Length")
            if length is not None and int(length) > limit:
                raise UpdateError(f"download exceeds {limit} bytes")
            value = response.read(limit + 1)
    except (OSError, ValueError) as error:
        raise UpdateError(f"cannot fetch {url}: {error}") from error
    if len(value) > limit:
        raise UpdateError(f"download exceeds {limit} bytes")
    return value


def local_revision(skill_root: Path) -> str | None:
    path = skill_root / "PROVENANCE.json"
    if not path.is_file() or path.is_symlink():
        return None
    provenance = parse_json(path.read_bytes(), "installed PROVENANCE.json")
    if not isinstance(provenance, dict):
        return None
    revision = provenance.get("revision")
    return revision if isinstance(revision, str) and REVISION.fullmatch(revision) else None


def project_id(skill_root: Path) -> str:
    path = skill_root / "project.json"
    if not path.is_file() or path.is_symlink():
        raise UpdateError("installed skill has no regular project.json")
    project = parse_json(path.read_bytes(), "project.json")
    if not isinstance(project, dict):
        raise UpdateError("project.json must contain an object")
    value = project.get("id")
    if not isinstance(value, str) or not ID.fullmatch(value):
        raise UpdateError("project.json has an invalid project id")
    if skill_root.name != f"contribute-to-{value}":
        raise UpdateError("skill directory name does not match project.json")
    return value


def manifest_for(value: bytes, expected_id: str) -> dict[str, Any]:
    manifest = record(
        parse_json(value, "published manifest"),
        {"schemaVersion", "id", "name", "repository", "revision", "source", "archive", "authority"},
        "published manifest",
    )
    expected_name = f"contribute-to-{expected_id}"
    if manifest["schemaVersion"] != 1 or manifest["id"] != expected_id or manifest["name"] != expected_name:
        raise UpdateError("published manifest identifies a different skill")
    if manifest["repository"] != SHIP_REPOSITORY or not isinstance(manifest["revision"], str) or not REVISION.fullmatch(manifest["revision"]):
        raise UpdateError("published manifest has invalid source identity")
    archive = record(manifest["archive"], {"url", "checksumUrl", "sha256", "bytes"}, "manifest.archive")
    expected_url = f"{PUBLIC_ORIGIN}/skills/v1/{expected_id}/{expected_name}.skill"
    if archive["url"] != expected_url or not isinstance(archive["sha256"], str) or not SHA256.fullmatch(archive["sha256"]):
        raise UpdateError("published manifest has invalid archive metadata")
    if not isinstance(archive["bytes"], int) or isinstance(archive["bytes"], bool) or not 1 <= archive["bytes"] <= MAX_DOWNLOAD_BYTES:
        raise UpdateError("published manifest has invalid archive size")
    return manifest


def safe_relative(value: Any) -> str:
    path = text(value, "provenance file path")
    pure = PurePosixPath(path)
    if pure.is_absolute() or path != pure.as_posix() or any(part in {"", ".", ".."} for part in pure.parts):
        raise UpdateError(f"unsafe archive path: {path}")
    return path


def verified_files(archive_bytes: bytes, name: str, revision: str) -> dict[str, bytes]:
    try:
        with tempfile.TemporaryFile() as temporary:
            temporary.write(archive_bytes)
            temporary.seek(0)
            with zipfile.ZipFile(temporary) as archive:
                infos = [info for info in archive.infolist() if not info.is_dir()]
                if not 1 <= len(infos) <= MAX_FILES:
                    raise UpdateError("skill archive has an invalid file count")
                files: dict[str, bytes] = {}
                tree_bytes = 0
                for info in infos:
                    path = PurePosixPath(info.filename)
                    if path.is_absolute() or len(path.parts) < 2 or path.parts[0] != name or any(part in {"", ".", ".."} for part in path.parts):
                        raise UpdateError(f"unsafe archive entry: {info.filename}")
                    mode = info.external_attr >> 16
                    if mode and (mode & 0o170000) not in {0, 0o100000}:
                        raise UpdateError(f"non-regular archive entry: {info.filename}")
                    relative = PurePosixPath(*path.parts[1:]).as_posix()
                    if relative in files or info.file_size > MAX_FILE_BYTES:
                        raise UpdateError(f"invalid archive entry: {info.filename}")
                    tree_bytes += info.file_size
                    if tree_bytes > MAX_TREE_BYTES:
                        raise UpdateError("skill archive exceeds the expanded size bound")
                    files[relative] = archive.read(info)
    except (OSError, zipfile.BadZipFile, RuntimeError) as error:
        if isinstance(error, UpdateError):
            raise
        raise UpdateError(f"invalid skill archive: {error}") from error

    provenance = record(
        parse_json(files.get("PROVENANCE.json", b""), "PROVENANCE.json"),
        {"schemaVersion", "name", "repository", "revision", "source", "files"},
        "PROVENANCE.json",
    )
    if provenance["schemaVersion"] != 1 or provenance["name"] != name or provenance["repository"] != SHIP_REPOSITORY or provenance["revision"] != revision:
        raise UpdateError("archive provenance does not match the published manifest")
    entries = provenance["files"]
    if not isinstance(entries, list) or not entries:
        raise UpdateError("archive provenance has no file manifest")
    expected: dict[str, str] = {}
    for candidate in entries:
        entry = record(candidate, {"path", "sha256"}, "provenance file")
        path = safe_relative(entry["path"])
        digest = entry["sha256"]
        if path == "PROVENANCE.json" or path in expected or not isinstance(digest, str) or not SHA256.fullmatch(digest):
            raise UpdateError("archive provenance contains an invalid file")
        expected[path] = digest
    if set(files) != set(expected) | {"PROVENANCE.json"}:
        raise UpdateError("archive files do not exactly match provenance")
    for path, digest in expected.items():
        if sha256(files[path]) != digest:
            raise UpdateError(f"archive file hash mismatch: {path}")
    source = record(provenance["source"], {"path", "sha256"}, "provenance.source")
    if source["path"] != f"skills/{name}/SKILL.md" or source["sha256"] != expected.get("SKILL.md"):
        raise UpdateError("archive provenance has invalid SKILL.md identity")
    return files


def install(skill_root: Path, name: str, files: dict[str, bytes]) -> None:
    parent = skill_root.parent
    staging_root = Path(tempfile.mkdtemp(prefix=f".{name}.update-", dir=parent))
    staged_skill = staging_root / name
    backup = parent / f".{name}.backup-{uuid.uuid4().hex}"
    moved_current = False
    try:
        staged_skill.mkdir()
        for relative, value in files.items():
            destination = staged_skill.joinpath(*PurePosixPath(relative).parts)
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(value)
        os.replace(skill_root, backup)
        moved_current = True
        try:
            os.replace(staged_skill, skill_root)
        except OSError:
            os.replace(backup, skill_root)
            moved_current = False
            raise
        shutil.rmtree(backup)
        moved_current = False
    except OSError as error:
        raise UpdateError(f"cannot replace installed skill: {error}") from error
    finally:
        if moved_current and backup.exists() and not skill_root.exists():
            os.replace(backup, skill_root)
        shutil.rmtree(staging_root, ignore_errors=True)


def update(skill_root: Path, fetch: Fetch = fetch_url) -> bool:
    skill_root = skill_root.resolve()
    if not skill_root.is_dir() or skill_root.is_symlink():
        raise UpdateError("skill root must be a regular directory")
    identifier = project_id(skill_root)
    name = f"contribute-to-{identifier}"
    cachebuster = uuid.uuid4().hex
    manifest_url = f"{PUBLIC_ORIGIN}/skills/v1/{identifier}/manifest.json?update={cachebuster}"
    manifest = manifest_for(fetch(manifest_url, MAX_DOWNLOAD_BYTES), identifier)
    revision = manifest["revision"]
    if local_revision(skill_root) == revision:
        return False
    archive = manifest["archive"]
    archive_bytes = fetch(f"{archive['url']}?update={cachebuster}", MAX_DOWNLOAD_BYTES)
    if len(archive_bytes) != archive["bytes"] or sha256(archive_bytes) != archive["sha256"]:
        raise UpdateError("downloaded archive does not match the published manifest")
    files = verified_files(archive_bytes, name, revision)
    install(skill_root, name, files)
    return True


def main() -> int:
    skill_root = Path(__file__).resolve().parent.parent
    changed = update(skill_root)
    if changed:
        print("Updated contributor skill. Reload its updated SKILL.md and follow it from the beginning.")
    else:
        print("Contributor skill is current.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except UpdateError as error:
        print(f"update-skill: {error}", file=sys.stderr)
        raise SystemExit(1)
