# Agent Artifacts

Private artifact storage for Codex, Claude, Hermes, and automation workflows. A Cloudflare Worker owns the API, R2 stores objects privately, D1 stores hash-only credentials and metadata, and explicit `/s/...` links provide temporary or retained evidence delivery.

## Capabilities

- Owner-isolated agent API keys with `artifact:write`, `artifact:read`, `artifact:delete`, and `share:create` scopes.
- SHA-256-verified uploads up to 50 MB and size-validated R2 multipart uploads above that limit.
- GET, HEAD, Range, ETag conditionals, private artifacts, and revocable opaque share URLs.
- `7d`, `30d`, and `retain` artifact policies with hourly cleanup of expired artifacts and stale multipart sessions.
- Cloudflare Access-aware admin console at `/admin` for keys, artifacts, shares, overview metrics, and audit events.
- One-time raw key reveal; D1 stores only a SHA-256 hash and short prefix.
- Shared CLI plus artifact-store, GitHub PR evidence, and Hermes gateway skills.

## Local setup

```bash
npm ci
npx wrangler d1 migrations apply agent-artifacts --local
npm test
npm run dev
```

Put `ADMIN_TOKEN=...` in `.dev.vars` for local dashboard use. Never commit `.dev.vars`, agent keys, or raw tokens. The dashboard keeps a break-glass token in `sessionStorage`, not persistent browser storage.

## Deploy

Create the private R2 bucket and D1 database named in `wrangler.jsonc`, then run:

```bash
npm run db:migrate:remote
npm run deploy
```

Set the Worker secret separately:

```bash
npx wrangler secret put ADMIN_TOKEN
```

For production admin access, create a Cloudflare Access self-hosted application for `/admin*` and `/v1/admin/*`, then set `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` in `wrangler.jsonc`. The Worker validates the `Cf-Access-Jwt-Assertion`; `ADMIN_TOKEN` remains a break-glass path for operational recovery and E2E.

## CLI

```bash
export ARTIFACTS_URL=https://agent-artifacts.example.workers.dev
export ARTIFACTS_API_KEY=ak_live_...

node cli/artifactctl.mjs upload screenshot.png --purpose pr-evidence --retention retain
node cli/artifactctl.mjs share ARTIFACT_ID --retention retain
node cli/artifactctl.mjs get ARTIFACT_ID --output ./download.png
node cli/artifactctl.mjs delete ARTIFACT_ID
```

Downloads stream to disk. Multipart failures trigger an abort, and wrapper failures delete artifacts they created.

## Verification

`npm test` runs unit and Worker-runtime integration tests against isolated local D1/R2 bindings. `npm run e2e` runs the full deployed API lifecycle and always attempts cleanup. Production E2E requires `ARTIFACTS_URL` and `ARTIFACTS_ADMIN_TOKEN`.

See [docs/decisions/0001-selective-reuse.md](docs/decisions/0001-selective-reuse.md) for upstream provenance and the reuse boundary.
