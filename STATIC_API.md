# Ship static API

`https://ship.freecodefund.xyz` is Ship's official static publication endpoint. A Cloudflare Worker serves static assets generated periodically from the canonical `freecodexyz/ship` `main` branch.

## Leaderboard snapshot

- `GET /api/v1/snapshot.json` — the current validated Ship snapshot (snapshot schema v3).
- `GET /api/v1/index.json` — publication metadata, source revision, byte size, and SHA-256 for the current snapshot.

The snapshot is a complete static input for custom leaderboards and other read-only UIs. Clients should tolerate newly added endpoints, but must reject unsupported snapshot schema versions.

## Contributor skills

- `GET /skills/v1/index.json` — available project skill artifacts.
- `GET /skills/v1/<project-id>/manifest.json` — source and archive metadata.
- `GET /skills/v1/<project-id>/skill.md` — canonical `SKILL.md` bytes.
- `GET /skills/v1/<project-id>/contribute-to-<project-id>.skill` — deterministic skill archive.
- `GET /skills/v1/<project-id>/contribute-to-<project-id>.skill.sha256` — transport checksum.

A `.skill` checksum detects transport corruption; it is not the trust root. Installers must authenticate the full revision and every canonical file against immutable GitHub bytes under `freecodexyz/ship@<revision>:skills/contribute-to-<project-id>` before activation.

## Browser access and caching

JSON, Markdown, checksum, and archive resources allow cross-origin `GET` access (`Access-Control-Allow-Origin: *`) so independently hosted interfaces can consume them. Mutable indexes and snapshots use short revalidation caching. Revision-bound skill archives are deterministic but their current project URLs remain mutable and therefore also require revalidation.
