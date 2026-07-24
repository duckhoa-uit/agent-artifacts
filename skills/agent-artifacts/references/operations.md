# Operations reference

## Environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `ARTIFACTS_URL` | Yes | Deployed Agent Artifacts Worker URL. |
| `ARTIFACTS_API_KEY` | Yes | Profile-scoped agent credential. |
| `GITHUB_REPOSITORY` | Optional | `OWNER/REPO` override for PR evidence. |

Create one API key per agent or profile. Grant only the scopes needed:

- `artifact:write` for uploads.
- `artifact:read` for authenticated downloads.
- `share:create` for bearerless share links.
- `artifact:delete` for explicit cleanup and wrapper rollback.

An API key belongs to a stable principal (the owner/profile name), not to one
key instance. Rotating a key for the same owner preserves access to that
owner's existing artifacts. Mark disposable CI, smoke, or E2E keys as
synthetic in the admin UI so their usage is excluded from the default admin
analytics totals.

The GitHub PR and Hermes workflows require write, share, and delete scopes
because they clean up artifacts when later delivery fails.

## artifactctl

```text
artifactctl upload FILE [--purpose PURPOSE] [--retention 7d|30d|retain]
                    [--content-type TYPE] [--source-agent NAME]
                    [--repo OWNER/REPO] [--pr NUMBER] [--task-id ID]
artifactctl share ARTIFACT_ID [--retention retain|temporary]
                              [--expires SECONDS]
artifactctl get ARTIFACT_ID --output FILE
artifactctl delete ARTIFACT_ID
```

Successful commands write one JSON object to stdout. The CLI reads the deployed
Worker's capabilities and uses multipart upload above its advertised direct-upload
limit.

For a coding-agent smoke test, upload a real file with a quoted path, parse the
returned `artifact_id`, download it to a separate path, and compare size and
SHA-256 before deleting the short-lived artifact.

## GitHub PR evidence

```text
github-pr-evidence --screenshot FILE [--video FILE] [--pr NUMBER] [--dry-run]
github-pr-evidence --video FILE [--pr NUMBER] [--dry-run]
```

The write path uploads retained evidence, creates share links, and creates or
updates the PR comment containing `<!-- agent-evidence:v1 -->`.

## Hermes media

```text
hermes-gateway-media FILE [--ttl SECONDS]
```

The output contains `artifact_id`, file metadata, SHA-256, share URL, and
expiry for Hermes to return directly.

## Troubleshooting

- `ARTIFACTS_URL and ARTIFACTS_API_KEY are required`: inject both variables
  into the agent process; do not add the key to the skill.
- `401`: the key is invalid, expired, or revoked.
- `403`: the key lacks a required scope.
- `404`: the artifact is absent or belongs to another key owner.
- A rotated key can read an existing artifact only when it uses the same owner
  name as the original key; changing the owner intentionally creates an
  isolated principal.
- GitHub command failure: run `gh auth status`, verify repository access, and
  pass `--pr` or `GITHUB_REPOSITORY` explicitly when auto-detection is wrong.

## Hermes distribution

Install the skill on the Hermes host with Hermes's native Skills Hub flow, or
with `npx skills add` targeting `hermes-agent` when distributing to several
agent runtimes. Do not assume a local Codex/Factory installation is visible to
a remote Hermes VPS. See [hermes.md](hermes.md) for the exact commands and
profile setup.
