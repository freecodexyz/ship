#!/usr/bin/env python3
"""Focused tests for onboarding plan validation and collision-safe scaffolding."""
from __future__ import annotations

import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse
from unittest.mock import patch

MODULE_PATH = Path(__file__).with_name("onboard.py")
SPEC = importlib.util.spec_from_file_location("ship_onboard", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
ONBOARD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ONBOARD)


def valid_plan() -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "project": {
            "id": "alpha-project",
            "name": "Alpha Project",
            "mission": "Improve Alpha through bounded, reviewable public contributions.",
            "repositories": [{"id": "owner/alpha", "branch": "main"}],
            "allowedModels": [],
            "reward": None,
        },
        "policy": {
            "modes": ["implementation", "review"],
            "issues": {
                "allowUnlabeled": False,
                "readyLabels": ["ready"],
                "blockedLabels": ["blocked"],
                "sensitiveLabels": ["security"],
                "epicLabels": ["epic"],
            },
            "claims": {
                "assignees": True,
                "implementationLabels": ["claimed"],
                "reviewLabels": ["review claimed"],
                "comments": {
                    "enabled": False,
                    "implementationPrefix": "CLAIMING:",
                    "reviewPrefix": "CLAIMING REVIEW:",
                    "trustedAssociations": ["OWNER", "MEMBER", "COLLABORATOR"],
                    "expiresAfterDays": 7,
                },
            },
            "priorityLabels": ["p0", "ready"],
            "verification": {"setup": [], "required": ["bun test"]},
            "evidence": {
                "implementation": ["State checks and observed results."],
                "review": ["Report concrete findings and checks."],
            },
            "guide": ["Read current repository instructions before work."],
        },
    }


def init_ship_checkout(root: Path, branch: str = "onboard-alpha") -> None:
    (root / "projects").mkdir()
    (root / "src").mkdir()
    subprocess.run(["git", "init", "-b", branch, str(root)], check=True, capture_output=True)
    subprocess.run(["git", "-C", str(root), "remote", "add", "upstream", "https://github.com/freecodexyz/ship.git"], check=True)


class OnboardTests(unittest.TestCase):
    def test_validates_complete_resolved_plan(self) -> None:
        self.assertEqual(ONBOARD.validate(valid_plan())["project"]["id"], "alpha-project")

    def test_rejects_unknown_fields(self) -> None:
        plan = valid_plan()
        plan["policy"]["customCode"] = "return true"
        with self.assertRaisesRegex(ONBOARD.InvalidPlan, "exactly"):
            ONBOARD.validate(plan)

    def test_rejects_conflicting_labels(self) -> None:
        plan = valid_plan()
        plan["policy"]["issues"]["blockedLabels"] = ["READY"]
        with self.assertRaisesRegex(ONBOARD.InvalidPlan, "appears in"):
            ONBOARD.validate(plan)

    def test_rejects_mutating_verification(self) -> None:
        plan = valid_plan()
        plan["policy"]["verification"]["required"] = ["git push origin main"]
        with self.assertRaisesRegex(ONBOARD.InvalidPlan, "mutating or unsafe"):
            ONBOARD.validate(plan)

    def test_handoff_prefills_exact_existing_project_manifest(self) -> None:
        plan = valid_plan()
        parsed = urlparse(ONBOARD.handoff_url(plan))
        query = parse_qs(parsed.query, strict_parsing=True)
        self.assertEqual(parsed.path, "/freecodexyz/ship/new/main")
        self.assertEqual(query["filename"], ["projects/alpha-project.json"])
        self.assertEqual(query["value"], [ONBOARD.project_bytes(plan["project"]).decode()])

    def test_browser_open_is_explicit_and_platform_bounded(self) -> None:
        with patch.object(ONBOARD.shutil, "which", side_effect=lambda command: "/usr/bin/open" if command == "open" else None):
            self.assertEqual(ONBOARD.browser_command("Darwin"), ["open"])
            self.assertIsNone(ONBOARD.browser_command("Windows"))
        with patch.object(ONBOARD.shutil, "which", return_value=None):
            with self.assertRaisesRegex(ONBOARD.InvalidPlan, "printed URL"):
                ONBOARD.open_handoff("https://github.com/example", "Linux")

    def test_scaffolds_pr_checkout_and_preserves_prefilled_manifest(self) -> None:
        plan = valid_plan()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            init_ship_checkout(root)
            project_path = root / "projects" / "alpha-project.json"
            project_path.write_bytes(ONBOARD.project_bytes(plan["project"]))
            written = ONBOARD.scaffold(plan, root)
            manifest = json.loads(project_path.read_text())
            self.assertEqual(set(manifest), {"id", "name", "repositories", "allowedModels"})
            skill = root / "skills" / "contribute-to-alpha-project"
            self.assertTrue((skill / "scripts" / "live-report.mjs").is_file())
            self.assertFalse((skill / "scripts" / "run-receipt.mjs").exists())
            self.assertEqual(len(written), 6)
            with self.assertRaisesRegex(FileExistsError, "existing contributor"):
                ONBOARD.scaffold(plan, root)

    def test_rejects_default_branch_and_mismatched_prefill(self) -> None:
        plan = valid_plan()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            init_ship_checkout(root, "main")
            with self.assertRaisesRegex(ONBOARD.InvalidPlan, "fork PR branch"):
                ONBOARD.scaffold(plan, root)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            init_ship_checkout(root)
            (root / "projects" / "alpha-project.json").write_text("{}\n")
            with self.assertRaisesRegex(FileExistsError, "does not exactly match"):
                ONBOARD.scaffold(plan, root)

    def test_modes_require_matching_evidence(self) -> None:
        plan = valid_plan()
        del plan["policy"]["evidence"]["review"]
        with self.assertRaisesRegex(ONBOARD.InvalidPlan, "exactly one entry"):
            ONBOARD.validate(plan)


if __name__ == "__main__":
    unittest.main()
