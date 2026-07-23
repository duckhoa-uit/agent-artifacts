# Operations reference

## Environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `ARTIFACTS_URL` | Yes | Deployed Agent Artifacts Worker URL. |
| `ARTIFACTS_API_KEY` | Yes | Profile-scoped agent credential. |
| `GITHUB_REPOSITORY` | Optional | `OWNER/REPO` override for PR evidence. |
| `HERMES_GATEWAY_MEDIA_URL` | Optional | Hermes gateway delivery endpoint. |
| `HERMES_GATEWAY_TOKEN` | Optional | Bearer credential for the Hermes gateway. |

Create one API key per agent or profile. Grant only the scopes needed:

- `artifact:write` for uploads.
- `artifact:read` for authenticated downloads.
- `share:create` for bearerless share links.
- `artifact:delete` for explicit cleanup and wrapper rollback.

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

Successful commands write one JSON object to stdout. Uploads larger than 50 MB
use multipart upload automatically.

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
expiry. `gateway_delivered` is present when optional gateway delivery succeeds.

## Troubleshooting

- `ARTIFACTS_URL and ARTIFACTS_API_KEY are required`: inject both variables
  into the agent process; do not add the key to the skill.
- `401`: the key is invalid, expired, or revoked.
- `403`: the key lacks a required scope.
- `404`: the artifact is absent or belongs to another key owner.
- GitHub command failure: run `gh auth status`, verify repository access, and
  pass `--pr` or `GITHUB_REPOSITORY` explicitly when auto-detection is wrong.

