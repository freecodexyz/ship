#!/usr/bin/env python3
"""Black-box tests for the bounded, GET-only repository inspector."""
from __future__ import annotations

import base64
import json
import os
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path
from typing import Any

SCRIPT = Path(__file__).with_name("inspect-repository.mjs")


def repository(*, truncated: bool = False) -> dict[str, Any]:
    return {
        "private": False,
        "full_name": "owner/alpha",
        "default_branch": "main",
        "archived": False,
        "disabled": False,
        "has_issues": True,
        "fork": False,
        "description": "Alpha repository",
        "homepage": "",
        "license": {"spdx_id": "MIT"},
        "topics": ["alpha"],
        "_truncated": truncated,
    }


def issue() -> dict[str, Any]:
    return {
        "number": 7,
        "title": "Bounded task",
        "user": {"login": "human"},
        "labels": [{"name": "help wanted"}],
        "assignees": [],
        "comments": 2,
        "updated_at": "2026-01-01T00:00:00Z",
        "milestone": {"title": "v1"},
        "html_url": "https://github.com/owner/alpha/issues/7",
    }


class InspectRepositoryTests(unittest.TestCase):
    def init_checkout(self, checkout: Path) -> None:
        subprocess.run(["git", "init", "-b", "main", str(checkout)], check=True, capture_output=True)
        subprocess.run(["git", "-C", str(checkout), "remote", "add", "origin", "https://github.com/owner/alpha.git"], check=True)
        subprocess.run(["git", "-C", str(checkout), "config", "user.name", "Test"], check=True)
        subprocess.run(["git", "-C", str(checkout), "config", "user.email", "test@example.com"], check=True)
        subprocess.run(["git", "-C", str(checkout), "add", "."], check=True)
        subprocess.run(["git", "-C", str(checkout), "commit", "--allow-empty", "-m", "fixture"], check=True, capture_output=True)

    def run_inspector(self, responses: dict[str, Any], checkout: Path | None = None) -> subprocess.CompletedProcess[str]:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "responses.json").write_text(json.dumps(responses))
            fake = root / "gh"
            fake.write_text(textwrap.dedent("""\
                #!/usr/bin/env python3
                import json, os, sys
                assert sys.argv[1:4] == ["api", "--method", "GET"]
                endpoint = sys.argv[-1]
                values = json.load(open(os.environ["FAKE_GH_RESPONSES"]))
                value = values[endpoint]
                if "--paginate" in sys.argv:
                    for item in value:
                        print(json.dumps(item, separators=(",", ":")))
                else:
                    print(json.dumps(value, separators=(",", ":")))
            """))
            fake.chmod(0o755)
            environment = os.environ | {
                "PATH": f"{root}{os.pathsep}{os.environ['PATH']}",
                "FAKE_GH_RESPONSES": str(root / "responses.json"),
            }
            command = ["node", str(SCRIPT), "--repo", "owner/alpha"]
            if checkout is not None:
                command += ["--checkout", str(checkout)]
            return subprocess.run(command, text=True, capture_output=True, env=environment)

    def responses(self, *, truncated: bool = False) -> dict[str, Any]:
        package = b'{"scripts":{"test":"bun test"}}\n'
        return {
            "repos/owner/alpha": repository(truncated=truncated),
            "repos/owner/alpha/commits/main": {"sha": "a" * 40},
            "repos/owner/alpha/labels?per_page=100": [
                {"name": "help wanted", "description": "Ready", "color": "00ff00"},
                {"name": "priority: high", "description": None, "color": "ff0000"},
            ],
            "repos/owner/alpha/issues?state=open&per_page=100&sort=updated&direction=desc": [issue()],
            "repos/owner/alpha/pulls?state=open&per_page=100&sort=updated&direction=desc": [],
            f"repos/owner/alpha/git/trees/{'a' * 40}?recursive=1": {
                "truncated": truncated,
                "tree": [
                    {"path": "AGENTS.md", "type": "blob", "size": 14, "sha": "b" * 40},
                    {"path": "packages/api/package.json", "type": "blob", "size": len(package), "sha": "c" * 40},
                    {"path": "src/index.ts", "type": "blob", "size": 10, "sha": "d" * 40},
                ],
            },
            f"repos/owner/alpha/git/blobs/{'c' * 40}": {
                "encoding": "base64", "size": len(package), "content": base64.b64encode(package).decode(),
            },
        }

    def test_collects_complete_policy_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            checkout = Path(directory)
            (checkout / "packages/api").mkdir(parents=True)
            (checkout / "AGENTS.md").write_text("Instructions.\n")
            (checkout / "packages/api/package.json").write_text('{"scripts":{"test":"bun test"}}\n')
            self.init_checkout(checkout)
            result = self.run_inspector(self.responses(), checkout)
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual(report["schemaVersion"], 2)
        self.assertEqual(report["labels"]["inferredGroups"]["ready"], ["help wanted"])
        self.assertEqual(report["labels"]["inferredGroups"]["priority"], ["priority: high"])
        self.assertEqual(report["labels"]["all"][0]["openUsage"], 1)
        self.assertTrue(report["repositoryFiles"]["complete"])
        self.assertEqual(report["repository"]["inspectedCommit"], "a" * 40)
        self.assertEqual(report["repositoryFiles"]["packageScripts"]["packages/api/package.json"]["test"], "bun test")
        self.assertEqual(report["open"]["issueSample"][0]["milestone"], "v1")
        self.assertEqual(report["local"]["packageScripts"]["packages/api/package.json"]["test"], "bun test")
        self.assertRegex(report["local"]["files"][0]["sha256"], r"^[a-f0-9]{64}$")

    def test_truncated_remote_tree_requires_checkout(self) -> None:
        result = self.run_inspector(self.responses(truncated=True))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("rerun with --checkout", result.stderr)

    def test_truncated_remote_tree_rejects_stale_checkout(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            checkout = Path(directory)
            self.init_checkout(checkout)
            result = self.run_inspector(self.responses(truncated=True), checkout)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("must be at inspectedCommit", result.stderr)

    def test_truncated_remote_tree_is_explicit_with_checkout(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            checkout = Path(directory)
            (checkout / "README.md").write_text("Alpha.\n")
            self.init_checkout(checkout)
            commit = subprocess.run(["git", "-C", str(checkout), "rev-parse", "HEAD"], check=True, text=True, capture_output=True).stdout.strip()
            responses = self.responses(truncated=True)
            responses["repos/owner/alpha/commits/main"]["sha"] = commit
            responses[f"repos/owner/alpha/git/trees/{commit}?recursive=1"] = responses.pop(f"repos/owner/alpha/git/trees/{'a' * 40}?recursive=1")
            result = self.run_inspector(responses, checkout)
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual(report["repositoryFiles"]["source"], "local-checkout")
        self.assertTrue(report["repositoryFiles"]["complete"])
        self.assertTrue(report["repositoryFiles"]["remoteTreeTruncated"])
        self.assertEqual(report["repositoryFiles"]["files"][0]["path"], "README.md")
        self.assertEqual(report["local"]["files"][0]["path"], "README.md")


if __name__ == "__main__":
    unittest.main()
