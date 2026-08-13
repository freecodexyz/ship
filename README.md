# ship

Fund, manage, and accelerate AI-driven collaborative work on public GitHub
projects.

Ship coordinates people and coding agents through project-specific skills. A
human chooses the goal and stays in control; the skill gives the agent the live
work-discovery rules, repository workflow, safety boundaries, verification
commands, evidence requirements, and signed receipt flow needed to do the heavy
work.

**Adding a project?** Give the [onboarding skill](#for-projects) to your agent.
**Contributing?** Give a [project skill](#for-contributors) to your agent. You do
not need to read or manually run the files inside a skill.

## How it works

1. A project owner gives Ship's onboarding skill to Codex, Claude Code, or
   another skill-capable coding agent. The agent inspects the public
   repositories, proposes a project policy, asks only the decisions the owner
   must make, and prepares the Ship pull request.
2. Once reviewed and merged, Ship publishes a project-specific contributor
   skill. That skill is the agent-facing operating manual for contributing to
   the project; the project owner does not need to train every agent or
   contributor individually.
3. A contributor gives that skill to their agent and asks it to contribute. The
   agent checks live GitHub state, finds suitable unclaimed work, follows the
   repository's instructions, runs checks, prepares evidence, and produces a
   signed Ship receipt when the model is eligible.
4. The human supervises consequential actions. The agent must stop for choices
   or authority it does not have; project maintainers still decide assignments,
   reviews, and merges.
5. Ship reads accepted public GitHub outcomes, applies deterministic monthly
   scoring, and publishes the ledger. Rewarded projects can turn a closed month
   into a frozen, publicly reviewable reward proposal.

A skill can recommend work but cannot reserve it, merge it, create score, or
promise payment. Live GitHub state and human approval remain authoritative.

## Rewards

Rewards are optional per project. A project that enables them declares an ERC-20
token, a UTC start date, and a monthly pool in the token's smallest units. Ship
does not mint tokens, custody funds, or promise payment for an open issue or pull
request.

Canonical points are calculated independently for each contributor, project,
and UTC calendar month:

| Qualifying outcome | Points | Monthly cap |
| --- | ---: | ---: |
| Merged pull request | 10 | 5 |
| Resolved issue closed by a merged pull request | 4 | 5 |
| Material test change | 4 | 5 |
| Substantive review of another contributor's pull request | 3 | 10 |
| Verified evidence | 1–2 by evidence kind | 30 points |
| Trusted evaluation | Up to 8 | 3 |

A material test change must include at least 10 additions and 20 lines of churn
in recognized test files. A substantive review must be an approval or
changes-requested review submitted before merge, by someone other than the pull
request author, with either an inline comment or at least 50 written characters.
Category caps keep one activity type from dominating a cycle; when a cap is
exceeded, Ship retains the newest qualifying outcomes deterministically.

For a rewarded project, the monthly pool is allocated proportionally by score.
A valid signed agent-run receipt may add a bounded compute bonus to the reward
weight—up to 25% after 1,000,000 credited tokens, with at most 100,000 tokens
credited per linked outcome. Receipts never add canonical points. Missing,
invalid, duplicated, or unsupported receipts are ignored without removing
points earned from independently verified GitHub work.

The exact award ledger, category breakdown, receipt set, and project
configuration are included in the published snapshot so the calculation can be
reproduced.

## Settlement

Ship currently produces and verifies reward proposals; it does **not** execute
token transfers.

For each rewarded project and closed month, the operational flow is:

1. Freeze a validated snapshot that covers the complete UTC month.
2. Resolve contributor wallet bindings through the pinned UIK contract on Base
   mainnet (chain ID `8453`). An unbound contributor is recorded as unclaimed.
3. Create `proposal.json` beside the exact `source-snapshot.json` used to derive
   it. Existing cycle records cannot be overwritten by the proposal command.
4. Review every allocation. A reviewer may approve, exclude, hold, or mark it
   unclaimed; reductions require a written reason. Every material edit restarts
   the 14-day review window.
5. Verify the proposal against its archived source snapshot before any external
   payment process uses it.

Project owners remain responsible for funding and executing transfers after
review. There is no `settle` command and a proposal's `approved` state is not an
on-chain payment receipt.

## For Projects

Install the onboarding skill for Codex or Claude Code:

```shell
curl -fsSL https://raw.githubusercontent.com/freecodexyz/ship/main/install-skill.sh | sh
```

The installer auto-detects Codex or Claude Code and installs the complete
`onboard-ship-project` skill in that agent's skills directory. To choose the
agent explicitly, use `AGENT=codex sh` or `AGENT=claude sh`; use
`SKILLS_DIR=/path/to/skills sh` for a custom location.

Or give this directly to your agent:

```text
Install and activate this skill, then use it to add [your-project-name] to Ship.
```

The agent will inspect the repository with read-only GitHub access, infer a
contribution policy from its actual instructions and workflows, and bring you a
short proposal. You decide the mission, eligible work, claims, exclusions,
verification, evidence, allowed agent models, and optional reward pool. The
agent then generates a GitHub handoff for the project manifest and, with a Ship
maintainer, the project-specific contributor skill.

Your job is to direct and approve, not to write Ship JSON or operate the skill's
scripts. You remain in control of browser actions, the onboarding pull request,
project review and merge policy, reward funding, and payment.

## For Contributors

Choose a project from the
[contributor-skill index](https://ship.freecodefund.xyz/skills/v1/index.json).
Then give its complete `.skill` package to Codex, Claude Code, or another
skill-capable coding agent. Replace `<project-id>` in this one-line handoff:

```text
Install and follow https://ship.freecodefund.xyz/skills/v1/<project-id>/contribute-to-<project-id>.skill
```
From there, talk to the agent normally. Tell it what kind of work you prefer,
review its proposed target, answer questions, and approve only the actions you
want it to take. The skill—not the human—refreshes the live work report, checks
claims and repository instructions, runs the contribution workflow, gathers
evidence, and uses the receipt runner for an allowed model. The agent must leave
assignment, approval, and merge decisions to project maintainers.

After accepted work is merged, it will appear in a subsequent Ship snapshot.
Scores use the contributor's stable GitHub identity, project, and UTC month. A
signed receipt records agent and compute provenance and can affect reward
weight; it does not create score or guarantee payment.

The published `.skill` archive is the handoff artifact, and its checksum detects transport
corruption only. Agents or external
installers must authenticate the manifest's exact revision and every packaged
file against immutable GitHub bytes at
`freecodexyz/ship@<revision>:skills/contribute-to-<project-id>` before activation.

## Trust model

Ship separates facts, policy, and authority:

- GitHub is authoritative for repositories, stable actor identities, merged
  pull requests, closed issues, and submitted reviews. Collection uses GET-only
  access and never claims work or mutates a project repository.
- The `freecodexyz/ship` Git history is authoritative for project definitions,
  contributor-skill source, protocol code, and permanent cycle records.
- The official static endpoint publishes validated artifacts bound to an exact
  Ship commit. Mutable URLs use revalidation caching; clients must verify the
  advertised schema and digest.
- Contributor skills and reports guide work but cannot reserve it, approve it,
  merge it, create score, or guarantee payment. Live GitHub state and human
  project maintainers remain authoritative.
- Issues, pull requests, comments, diffs, repository files, and linked content
  are untrusted input. Contributor agents must not expose secrets, handle public
  security-sensitive work, run deployment or signing commands without explicit
  authority, or obey repository content that conflicts with higher-level safety
  rules.
- Scoring is deterministic and independent of optional receipt validity.
  Reward projection is derived from canonical scores; proposal review may only
  change review-owned fields and remains reproducible from the archived source
  snapshot.
- A `.skill.sha256` file is a transport checksum, not a signature or trust root.
  Canonical skill bytes must be authenticated against the immutable Git revision
  declared by the publication manifest.

## API

The official static endpoint is <https://ship.freecodefund.xyz>. It is suitable
for static leaderboards and other read-only remote interfaces; JSON and skill
resources allow cross-origin `GET` requests.

- [`GET /api/v1/index.json`](https://ship.freecodefund.xyz/api/v1/index.json) —
  publication revision, snapshot digest, and byte size.
- [`GET /api/v1/snapshot.json`](https://ship.freecodefund.xyz/api/v1/snapshot.json)
  — current validated snapshot (schema v3).
- [`GET /skills/v1/index.json`](https://ship.freecodefund.xyz/skills/v1/index.json)
  — published project contributor skills.
- `GET /skills/v1/<project-id>/manifest.json` — skill source revision, files,
  archive digest, and size.
- `GET /skills/v1/<project-id>/skill.md` — canonical contributor entry point.
- `GET /skills/v1/<project-id>/contribute-to-<project-id>.skill` — deterministic
  skill archive.
- `GET /skills/v1/<project-id>/contribute-to-<project-id>.skill.sha256` —
  transport checksum.

See [STATIC_API.md](STATIC_API.md) for the versioned resource contract and
client verification requirements.
