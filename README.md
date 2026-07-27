# Agent Artifacts

Private, owner-isolated artifact handoff for coding agents. Agent Artifacts
stores screenshots, recordings, logs, build outputs, and other files behind a
Cloudflare Worker so an agent can return a stable link instead of trying to
push a binary through a gateway or a GitHub comment.

It is built around two common delivery gaps:

- **OpenClaw/Hermes gateway media** — when an agent can create a screenshot or
  video but its gateway cannot attach or transport the file reliably, upload it
  once and return a temporary share URL that Hermes can include in its reply.
- **GitHub PR evidence** — when `gh` cannot attach a UI diff, before/after
  screenshots, or a user-flow recording directly to a PR, upload the evidence
  and publish one maintained evidence comment with image and video links.

The service is private by default: artifacts are owner-isolated, R2 objects
are not public, and share URLs are explicit, revocable, and time-bounded.

## Primary use cases

| Use case | What the agent does | What the reviewer receives |
| --- | --- | --- |
| OpenClaw/Hermes media handoff | Upload a screenshot, screen recording, generated video, or log bundle from the agent workspace. | A temporary share URL that the gateway can return even when binary attachments are unavailable. |
| GitHub PR visual evidence | Capture before/after UI screenshots or record the complete user flow, then run the PR evidence helper. | A maintained PR comment containing inline screenshot evidence and playable/downloadable video links. |
| Durable agent artifacts | Store build reports, test output, fixtures, or generated files for another agent or human to inspect. | A private artifact ID, metadata, and an optional revocable share link. |

### Typical workflows

**Deliver media through Hermes or OpenClaw:**

```bash
node "$AGENT_ARTIFACTS_SKILL_DIR/scripts/hermes-gateway-media.mjs" \
  ./recording.mp4 --ttl 604800
```

The command uploads with short retention and prints JSON containing the
artifact ID, checksum, expiry, and share URL. Hermes can put that URL directly
in its response or gateway payload.

**Publish before/after UI or user-flow evidence on a GitHub PR:**

```bash
node "$AGENT_ARTIFACTS_SKILL_DIR/scripts/github-pr-evidence.mjs" \
  --screenshot ./before-after.png \
  --video ./user-flow.mp4 \
  --dry-run

node "$AGENT_ARTIFACTS_SKILL_DIR/scripts/github-pr-evidence.mjs" \
  --screenshot ./before-after.png \
  --video ./user-flow.mp4
```

The helper uploads and shares the files, then creates or updates one marked PR
comment. Re-running it replaces the previous evidence and cleans up the old
artifacts instead of creating comment or storage clutter.

## Capabilities

- Owner-isolated agent API keys with `artifact:write`, `artifact:read`, `artifact:delete`, and `share:create` scopes.
- SHA-256-verified direct uploads and size-validated R2 multipart uploads selected from the Worker's advertised capabilities.
- GET, HEAD, Range, ETag conditionals, private artifacts, and revocable opaque share URLs.
- Per-share download rate limiting and atomic per-owner multipart-session limits to bound storage abuse.
- `7d`, `30d`, and `retain` artifact policies with hourly cleanup of expired artifacts, stale multipart sessions, and retryable R2 deletion reconciliation.
- Cloudflare Access-aware admin console at `/admin` for keys, artifacts, shares, usage analytics, overview metrics, and audit events.
- Stable principal ownership across API-key rotation, with opt-in synthetic markers so E2E and smoke traffic stays out of production usage totals.
- Sandboxed artifact delivery: active document types download instead of executing under the admin origin.
- One-time raw key reveal; D1 stores only a SHA-256 hash and short prefix.
- A self-contained Agent Skills package for artifact operations, GitHub PR evidence, and Hermes media delivery.

## Local setup

```bash
npm ci
npx wrangler d1 migrations apply agent-artifacts --local
npm test
npm run dev
```

Put `ADMIN_TOKEN=...` in `.dev.vars` for local dashboard use. Never commit `.dev.vars`, agent keys, or raw tokens. The dashboard keeps a break-glass token in `sessionStorage`, not persistent browser storage.

## Environment variables

The shared `.env.example` intentionally contains only the Worker URL. Keep the
other values in the environment where they are used, not in the repository.

| Variable | Used by | Required | Purpose |
| --- | --- | --- | --- |
| `ARTIFACTS_URL` | CLI, setup script, E2E | Yes for integrations | Deployed Worker URL. |
| `ARTIFACTS_API_KEY` | `artifactctl` and agent skills | For private artifact operations | Profile-scoped key created in the admin UI. |
| `ADMIN_TOKEN` | Worker secret, local admin UI | Optional with Cloudflare Access | Break-glass admin authentication. |
| `MAX_SMALL_UPLOAD_BYTES` | Worker | Yes | Maximum size for a direct upload. |
| `MULTIPART_PART_SIZE_BYTES` | Worker | Yes | Size of each multipart upload part. |
| `DEFAULT_SHARE_TTL_SECONDS` | Worker | Yes | Default lifetime of temporary share links. |
| `UPLOAD_SESSION_TTL_SECONDS` | Worker | Yes | Age after which inactive multipart sessions are cleaned up. |
| `ACCESS_TEAM_DOMAIN` | Worker | Yes for Access admin | Cloudflare Access team domain used to verify JWTs. |
| `ACCESS_AUDIENCE` | Worker | Yes for Access admin | Audience for the Access application protecting both admin destinations. |
| `CLOUDFLARE_ACCOUNT_ID` | Wrangler and `configure-access.mjs` | Deploy/setup only | Cloudflare account targeted by the operation. |
| `CLOUDFLARE_API_TOKEN` | Wrangler and `configure-access.mjs` | Deploy/setup only | Cloudflare API credential. |
| `ACCESS_ALLOWED_EMAIL` | `configure-access.mjs` | Access setup only | Email granted the admin Access policy. |
| `ARTIFACTS_E2E_ADMIN_TOKEN` | `npm run e2e` | One E2E auth option | Break-glass credential for production E2E. |
| `ARTIFACTS_E2E_ACCESS_CLIENT_ID` | `configure-access.mjs`, `npm run e2e` | Pair, one E2E auth option | Cloudflare Access service-token client ID; setup also binds this exact token to the managed Service Auth policy. |
| `ARTIFACTS_E2E_ACCESS_CLIENT_SECRET` | `npm run e2e` | Pair, one E2E auth option | Cloudflare Access service-token client secret. |
| `GITHUB_REPOSITORY` | `github-pr-evidence.mjs` | Optional | Repository override; otherwise the CLI asks `gh` for the current repository. |

Production E2E needs `ARTIFACTS_URL` and either `ARTIFACTS_E2E_ADMIN_TOKEN` or
the Access service-token pair. The E2E variables are not Worker runtime
configuration.

The Worker exposes `GET /v1/capabilities`; bundled clients use it to select
direct or multipart upload without duplicating deployment limits.

## Deploy

The committed `wrangler.jsonc` describes the existing production instance.
Its Worker name, R2 bucket, D1 database ID, and Cloudflare Access values are
deployment state, not portable defaults.

### Operate the existing production instance

Do not replace the committed bindings or Access values. Run the read-only
production preflight in [the deployment guide](docs/DEPLOYMENT.md), then use
the repository's manually dispatched `Deploy` workflow. The workflow applies
remote D1 migrations before deploying the Worker and finishes with live E2E
verification.

### Create a separate instance

Do not deploy the committed account-specific values into another Cloudflare
account. Follow [the fresh-instance procedure](docs/DEPLOYMENT.md#provision-a-separate-instance)
to create a new private R2 bucket and D1 database, replace the D1 database ID
and other deployment-specific values, configure Access for the new Worker
hostname, verify every binding, apply migrations, and deploy with the required
Worker secret supplied outside the repository. Resource names alone do not
select a D1 database.

Never add Cloudflare credentials, the break-glass admin secret, or agent API
keys to `wrangler.jsonc`, `.env.example`, or another committed file.

## Agent skill

Install the self-contained `agent-artifacts` skill from GitHub. The installer
places `SKILL.md`, its scripts, and its referenced files in the selected agent's
native skill directory.

Browse the published skill at
[skills.sh/duckhoa-uit/agent-artifacts/agent-artifacts](https://skills.sh/duckhoa-uit/agent-artifacts/agent-artifacts).

Project-scoped installation:

```bash
npx skills add duckhoa-uit/agent-artifacts --skill agent-artifacts
```

Global installation for Codex, Claude Code, and Hermes Agent:

```bash
npx skills add duckhoa-uit/agent-artifacts \
  --skill agent-artifacts \
  --global \
  --agent codex claude-code hermes-agent \
  --copy \
  --yes
```

For a Hermes-only VPS, the native Hermes Skills Hub flow is preferred. Run this
on that VPS as the Hermes service user:

```bash
hermes skills tap add duckhoa-uit/agent-artifacts
hermes skills install duckhoa-uit/agent-artifacts/agent-artifacts
```

The public repository installs without a GitHub credential. Hermes installs
the skill under `~/.hermes/skills/agent-artifacts`, including only the
referenced scripts and references; the source repository is not required at
runtime. Use the `npx skills` command above when the same release is also being
installed into other agent runtimes. See
[the Hermes distribution reference](skills/agent-artifacts/references/hermes.md)
for update and verification commands.

Inject `ARTIFACTS_URL` and a profile-scoped `ARTIFACTS_API_KEY` into each
agent's own environment. Hermes declares both variables in the skill
frontmatter and passes them to its terminal/execute-code sandbox when the skill
loads. Use separate non-synthetic keys for production Hermes profiles and
synthetic keys only for disposable smoke/E2E profiles. The installed skill
chooses and runs its bundled workflow; agents do not need the source repository
or a globally installed `artifactctl`.

## CLI

The root CLI remains available for repository development and delegates to the
same scripts bundled with the skill. The Worker URL is the only endpoint
configuration. Private artifact commands also require a profile-scoped API
key; the key is deliberately not included in the shared `.env.example`.

```bash
export ARTIFACTS_URL=https://agent-artifacts.example.workers.dev
# Required only when using the private artifact CLI:
export ARTIFACTS_API_KEY=ak_live_...

node cli/artifactctl.mjs upload screenshot.png --purpose pr-evidence --retention retain
node cli/artifactctl.mjs share ARTIFACT_ID --retention retain
node cli/artifactctl.mjs get ARTIFACT_ID --output ./download.png
node cli/artifactctl.mjs delete ARTIFACT_ID
```

Downloads stream to disk. Multipart failures trigger a retryable abort, files
are checked for mutation during upload, and wrapper failures delete artifacts
they created.

## Verification

`npm test` runs unit and Worker-runtime integration tests against isolated local D1/R2 bindings. `npm run e2e` runs the full deployed API lifecycle and always attempts cleanup, including key rotation, admin analytics, range/conditional reads, share revocation, and cleanup. Production E2E requires `ARTIFACTS_URL` plus either `ARTIFACTS_E2E_ADMIN_TOKEN` or the `ARTIFACTS_E2E_ACCESS_CLIENT_ID` / `ARTIFACTS_E2E_ACCESS_CLIENT_SECRET` Cloudflare Access service-token pair.

Hourly cleanup retries interrupted R2 work, retains audit history for 90 days,
and purges reconciled tombstones after 30 days.

See [docs/decisions/0001-selective-reuse.md](docs/decisions/0001-selective-reuse.md)
for upstream provenance and
[docs/decisions/0002-runtime-hardening.md](docs/decisions/0002-runtime-hardening.md)
for the delivery and lifecycle boundaries.

## Security

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
Never include credentials or private artifact URLs in a public issue.

## License

Licensed under the [MIT License](LICENSE). The deployed service remains private
by default: publishing this source repository does not bypass its API-key,
owner-isolation, or Cloudflare Access controls.
