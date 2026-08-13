#!/usr/bin/env python3
"""Focused tests for contributor-skill self-updates."""
from __future__ import annotations

import hashlib
import importlib.util
import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from typing import Any

MODULE_PATH = Path(__file__).parents[1] / "assets" / "update-skill.py"
SPEC = importlib.util.spec_from_file_location("ship_update_skill", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
UPDATER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(UPDATER)


def encoded(value: Any) -> bytes:
    return f"{json.dumps(value, sort_keys=True)}\n".encode()


def digest(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


class Fixture:
    def __init__(self, revision: str, skill_markdown: bytes = b"new skill\n") -> None:
        self.identifier = "alpha-project"
        self.name = f"contribute-to-{self.identifier}"
        project = encoded({"id": self.identifier})
        updater = b"updated helper\n"
        canonical = {
            "SKILL.md": skill_markdown,
            "project.json": project,
            "scripts/update-skill.py": updater,
        }
        provenance = {
            "schemaVersion": 1,
            "name": self.name,
            "repository": UPDATER.SHIP_REPOSITORY,
            "revision": revision,
            "source": {
                "path": f"skills/{self.name}/SKILL.md",
                "sha256": digest(skill_markdown),
            },
            "files": [
                {"path": path, "sha256": digest(value)}
                for path, value in sorted(canonical.items())
            ],
        }
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            for path, value in canonical.items():
                archive.writestr(f"{self.name}/{path}", value)
            archive.writestr(f"{self.name}/PROVENANCE.json", encoded(provenance))
        self.archive = buffer.getvalue()
        archive_url = f"{UPDATER.PUBLIC_ORIGIN}/skills/v1/{self.identifier}/{self.name}.skill"
        self.manifest = encoded({
            "schemaVersion": 1,
            "id": self.identifier,
            "name": self.name,
            "repository": UPDATER.SHIP_REPOSITORY,
            "revision": revision,
            "source": {},
            "archive": {
                "url": archive_url,
                "checksumUrl": f"{archive_url}.sha256",
                "sha256": digest(self.archive),
                "bytes": len(self.archive),
            },
            "authority": {},
        })

    def install_old(self, parent: Path, revision: str | None = None) -> Path:
        root = parent / self.name
        (root / "scripts").mkdir(parents=True)
        (root / "project.json").write_bytes(encoded({"id": self.identifier}))
        (root / "SKILL.md").write_text("old skill\n")
        (root / "stale.txt").write_text("remove me\n")
        if revision is not None:
            (root / "PROVENANCE.json").write_bytes(encoded({"revision": revision}))
        return root

    def fetch(self, calls: list[str]):
        def fetch(url: str, _limit: int) -> bytes:
            calls.append(url)
            return self.manifest if "/manifest.json?" in url else self.archive
        return fetch


class UpdateSkillTests(unittest.TestCase):
    def test_replaces_the_complete_stale_skill(self) -> None:
        fixture = Fixture("b" * 40)
        calls: list[str] = []
        with tempfile.TemporaryDirectory() as directory:
            root = fixture.install_old(Path(directory))
            self.assertTrue(UPDATER.update(root, fixture.fetch(calls)))
            self.assertEqual((root / "SKILL.md").read_text(), "new skill\n")
            self.assertEqual((root / "scripts" / "update-skill.py").read_text(), "updated helper\n")
            self.assertFalse((root / "stale.txt").exists())
            self.assertEqual(len(calls), 2)

    def test_skips_archive_when_installed_revision_is_current(self) -> None:
        revision = "c" * 40
        fixture = Fixture(revision)
        calls: list[str] = []
        with tempfile.TemporaryDirectory() as directory:
            root = fixture.install_old(Path(directory), revision)
            self.assertFalse(UPDATER.update(root, fixture.fetch(calls)))
            self.assertEqual(len(calls), 1)

    def test_rejects_an_archive_that_does_not_match_manifest(self) -> None:
        fixture = Fixture("d" * 40)
        with tempfile.TemporaryDirectory() as directory:
            root = fixture.install_old(Path(directory))
            original = (root / "SKILL.md").read_bytes()

            def fetch(url: str, _limit: int) -> bytes:
                return fixture.manifest if "/manifest.json?" in url else fixture.archive + b"tampered"

            with self.assertRaisesRegex(UPDATER.UpdateError, "does not match"):
                UPDATER.update(root, fetch)
            self.assertEqual((root / "SKILL.md").read_bytes(), original)
            self.assertTrue((root / "stale.txt").is_file())

    def test_rejects_a_manifest_for_another_skill(self) -> None:
        fixture = Fixture("e" * 40)
        manifest = json.loads(fixture.manifest)
        manifest["id"] = "other-project"
        with tempfile.TemporaryDirectory() as directory:
            root = fixture.install_old(Path(directory))
            with self.assertRaisesRegex(UPDATER.UpdateError, "different skill"):
                UPDATER.update(root, lambda _url, _limit: encoded(manifest))


if __name__ == "__main__":
    unittest.main()
