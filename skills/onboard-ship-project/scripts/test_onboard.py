#!/usr/bin/env python3
"""Focused tests for onboarding plan validation and collision-safe scaffolding."""
from __future__ import annotations

import importlib.util
import json
import os
import shutil
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
                "implementationLabelPrefixes": ["claimed:", "in-progress:"],
                "reviewLabels": ["review claimed"],
                "reviewLabelPrefixes": ["review-claimed:"],
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
            self.assertEqual(set(manifest), {"id", "name", "mission", "repositories", "allowedModels"})
            skill = root / "skills" / "contribute-to-alpha-project"
            self.assertTrue((skill / "scripts" / "live-report.mjs").is_file())
            self.assertTrue((skill / "scripts" / "run-receipt.mjs").is_file())
            self.assertTrue((skill / "scripts" / "update-skill.py").is_file())
            skill_markdown = (skill / "SKILL.md").read_text()
            first_step = skill_markdown.index("## Mandatory first step")
            workflow = skill_markdown.index("1. Run `node")
            self.assertLess(first_step, workflow)
            self.assertIn("python3 <skill>/scripts/update-skill.py", skill_markdown)
            self.assertEqual(json.loads((skill / "project.json").read_text())["allowedModels"], plan["project"]["allowedModels"])
            self.assertEqual(len(written), 8)
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

    def test_generated_receipt_rejects_unapproved_model(self) -> None:
        plan = valid_plan()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            init_ship_checkout(root)
            ONBOARD.scaffold(plan, root)
            runner = root / "skills" / "contribute-to-alpha-project" / "scripts" / "run-receipt.mjs"
            result = subprocess.run([shutil.which("node") or "node", str(runner), "start", "--client", "codex", "--provider", "openai", "--model", "gpt-test"], text=True, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("project.allowedModels", result.stderr)

    def test_generated_receipt_passes_ship_contract(self) -> None:
        plan = valid_plan()
        plan["project"]["allowedModels"] = [{"client": "codex", "provider": "openai", "model": "gpt-test"}]
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            ship = base / "ship"
            ship.mkdir()
            init_ship_checkout(ship)
            ONBOARD.scaffold(plan, ship)
            subprocess.run(["git", "-C", str(ship), "config", "user.name", "Test"], check=True)
            subprocess.run(["git", "-C", str(ship), "config", "user.email", "test@example.com"], check=True)
            subprocess.run(["git", "-C", str(ship), "add", "."], check=True)
            subprocess.run(["git", "-C", str(ship), "commit", "-m", "fixture"], check=True, capture_output=True)
            contribution = base / "alpha"
            contribution.mkdir()
            subprocess.run(["git", "init", "-b", "work", str(contribution)], check=True, capture_output=True)
            subprocess.run(["git", "-C", str(contribution), "remote", "add", "origin", "https://github.com/owner/alpha.git"], check=True)
            runner = ship / "skills" / "contribute-to-alpha-project" / "scripts" / "run-receipt.mjs"
            git_directory = str(Path(shutil.which("git") or "/usr/bin/git").parent)
            environment = os.environ | {"XDG_CONFIG_HOME": str(base / "config"), "PATH": git_directory}
            common = ["--client", "codex", "--provider", "openai", "--model", "gpt-test", "--repo-root", str(contribution), "--json"]
            started = subprocess.run([shutil.which("node") or "node", str(runner), "start", *common], text=True, capture_output=True, env=environment)
            self.assertEqual(started.returncode, 0, started.stderr)
            run_id = json.loads(started.stdout)["runId"]
            finished = subprocess.run([shutil.which("node") or "node", str(runner), "finish", *common, "--run", run_id], check=True, text=True, capture_output=True, env=environment)
            marker = json.loads(finished.stdout)["marker"]
            contract = base / "contract.ts"
            contract.write_text(f'''import {{parseReceiptMarker, validateReceipt}} from {json.dumps(str(Path.cwd() / "src" / "receipts.ts"))};\nimport {{parseRepoId}} from {json.dumps(str(Path.cwd() / "src" / "types.ts"))};\nconst receipt = parseReceiptMarker(process.env.MARKER!);\nconst project = {{id: "alpha-project", name: "Alpha Project", repositories: [{{id: parseRepoId("owner/alpha"), branch: "main"}}], allowedModels: [{{client: "codex" as const, provider: "openai", model: "gpt-test"}}]}};\nconst pull = {{id: "PR_fixture", repo: parseRepoId("owner/alpha"), number: 1, title: "Fixture", author: {{id: "U_fixture", login: "test"}}, mergedAt: "2999-01-01T00:00:00.000Z", headSha: "a".repeat(40), files: [], closedIssueIds: [], reviews: [], evidence: []}} as const;\nvalidateReceipt(receipt, project, pull);\nconsole.log(receipt.usage.confidence);\n''')
            checked = subprocess.run(["bun", str(contract)], check=True, text=True, capture_output=True, env=os.environ | {"MARKER": marker})
            self.assertEqual(checked.stdout.strip(), "unavailable")

    def test_rejects_unbounded_claim_label_prefixes(self) -> None:
        plan = valid_plan()
        plan["policy"]["claims"]["implementationLabelPrefixes"] = ["claimed"]
        with self.assertRaisesRegex(ONBOARD.InvalidPlan, "ending in a colon"):
            ONBOARD.validate(plan)

    def test_live_report_conservatively_resolves_claims_epics_and_reviews(self) -> None:
        plan = valid_plan()
        plan["policy"]["claims"]["comments"]["enabled"] = True
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            skill = root / "skill"
            scripts = skill / "scripts"
            scripts.mkdir(parents=True)
            shutil.copyfile(Path(__file__).parents[1] / "assets" / "live-report.mjs", scripts / "live-report.mjs")
            (skill / "project.json").write_text(json.dumps({
                "schemaVersion": 1,
                "id": "alpha-project",
                "name": "Alpha Project",
                "repositories": [{"id": "owner/alpha", "branch": "main"}],
            }))
            (skill / "policy.json").write_text(json.dumps({"schemaVersion": 2, **plan["policy"]}))
            fake_bin = root / "bin"
            fake_bin.mkdir()
            gh = fake_bin / "gh"
            gh.write_text('''#!/usr/bin/env python3
import json, sys
from datetime import datetime, timezone
endpoint = sys.argv[-1]
sha = "a" * 40
now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
user = lambda login, kind="User", identifier=1: {"login": login, "type": kind, "id": identifier}
def issue(number, title="Work", labels=None, assignees=None, comments=0):
    return {"number": number, "title": title, "html_url": f"https://github.test/issues/{number}", "updated_at": "2025-01-01T00:00:00Z", "labels": labels or ["ready"], "assignees": assignees or [], "comments": comments, "user": user(f"author{number}", identifier=number), "author_association": "CONTRIBUTOR"}
def pull(number, **changes):
    value = issue(number)
    value.update({"html_url": f"https://github.test/pull/{number}", "draft": False, "requested_reviewers": [], "requested_teams": [], "head": {"sha": sha}})
    value.update(changes)
    return value
responses = {}
responses["repos/owner/alpha/issues?state=open&per_page=100&sort=updated&direction=desc"] = [
    issue(1, labels=["ready", "claimed:alice"]),
    issue(2, title="[Epic] broad migration"),
    issue(9, title="Bounded issue"),
]
responses["repos/owner/alpha/pulls?state=open&per_page=100&sort=updated&direction=desc"] = [
    pull(3, assignees=[user("maintainer", identifier=30)]),
    pull(4),
    pull(5),
    pull(6),
    pull(7),
    pull(8, user={"login": "mystery", "type": "Organization", "id": 80}),
    pull(10),
    pull(11, labels=["review-claimed:bob"]),
    pull(12),
    pull(13, assignees=[{"login": "mystery", "type": "Organization", "id": 130}]),
]
responses["repos/owner/alpha/pulls/4/comments?per_page=100"] = [{"body": "CLAIMING REVIEW: taking this", "created_at": now, "author_association": "MEMBER", "user": user("reviewer", identifier=40)}]
responses["repos/owner/alpha/pulls/5/reviews?per_page=100"] = [{"state": "APPROVED", "submitted_at": "2025-01-02T00:00:00Z", "commit_id": sha, "user": user("ci-bot", "Bot", 50)}]
responses["repos/owner/alpha/pulls/6/reviews?per_page=100"] = [{"state": "APPROVED", "submitted_at": "2025-01-02T00:00:00Z", "commit_id": sha, "user": user("author6", identifier=6)}]
responses["repos/owner/alpha/pulls/7/reviews?per_page=100"] = [{"state": "APPROVED", "submitted_at": "2025-01-02T00:00:00Z", "commit_id": sha, "user": user("reviewer", identifier=70)}]
responses["repos/owner/alpha/pulls/10/reviews?per_page=100"] = [
    {"state": "APPROVED", "submitted_at": "2025-01-01T00:00:00Z", "commit_id": sha, "user": user("reviewer", identifier=100)},
    {"state": "DISMISSED", "submitted_at": "2025-01-02T00:00:00Z", "commit_id": sha, "user": user("reviewer", identifier=100)},
]
responses["repos/owner/alpha/pulls/12/reviews?per_page=100"] = [{"state": "APPROVED", "submitted_at": None, "commit_id": None, "user": user("reviewer", identifier=120)}]
for value in responses.get(endpoint, []): print(json.dumps(value))
''')
            gh.chmod(0o755)
            result = subprocess.run(
                [shutil.which("node") or "node", str(scripts / "live-report.mjs"), "--json"],
                text=True,
                capture_output=True,
                env=os.environ | {"PATH": f"{fake_bin}{os.pathsep}{os.environ.get('PATH', '')}"},
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            report = json.loads(result.stdout)
            self.assertEqual({item["id"] for item in report["candidates"]}, {"owner/alpha#5", "owner/alpha#6", "owner/alpha#9", "owner/alpha#10"})
            reasons = {item["id"]: item["reasons"] for item in report["excluded"]}
            self.assertIn("claimed", reasons["owner/alpha#1"])
            self.assertIn("epic", reasons["owner/alpha#2"])
            self.assertIn("assigned", reasons["owner/alpha#3"])
            self.assertIn("claimed", reasons["owner/alpha#4"])
            self.assertIn("already-approved", reasons["owner/alpha#7"])
            self.assertIn("unknown-author", reasons["owner/alpha#8"])
            self.assertIn("claimed", reasons["owner/alpha#11"])
            self.assertIn("unverifiable-review-state", reasons["owner/alpha#12"])
            self.assertIn("unverifiable-assignee", reasons["owner/alpha#13"])

    def test_modes_require_matching_evidence(self) -> None:
        plan = valid_plan()
        del plan["policy"]["evidence"]["review"]
        with self.assertRaisesRegex(ONBOARD.InvalidPlan, "exactly one entry"):
            ONBOARD.validate(plan)


if __name__ == "__main__":
    unittest.main()
