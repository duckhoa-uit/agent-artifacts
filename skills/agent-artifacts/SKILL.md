---
name: agent-artifacts
description: Secure artifact handoff for coding agents, including Hermes/OpenClaw media and GitHub PR evidence.
compatibility: Requires Node.js 22 or newer, network access to the configured Worker, ARTIFACTS_URL, and a scoped ARTIFACTS_API_KEY. GitHub PR evidence additionally requires an authenticated gh CLI.
required_environment_variables:
  - name: ARTIFACTS_URL
    prompt: Agent Artifacts Worker URL
    help: Use the deployed Agent Artifacts Worker URL, for example https://agent-artifacts.example.workers.dev.
    required_for: artifact operations
  - name: ARTIFACTS_API_KEY
    prompt: Agent Artifacts API key
    help: Use a profile-scoped key from the Agent Artifacts admin UI; never use an admin or deployment credential.
    required_for: private artifact operations
metadata:
  author: duckhoa-uit
  version: "0.3.0"
---

# Agent Artifacts Skill

Use the bundled scripts to persist files outside the coding workspace and return
stable metadata or revocable share links. This is especially useful when
OpenClaw or Hermes cannot transport a screenshot/video through its gateway, or
when a GitHub PR needs before/after UI evidence or a recorded user flow.
Resolve the directory containing this
`SKILL.md` and use its absolute path as `AGENT_ARTIFACTS_SKILL_DIR` in the
commands below; do not assume the current working directory is the skill
directory.

## When to Use

Load this skill when a user asks an agent to upload, download, share, preserve,
or clean up a generated file, attach visual evidence to a PR, or return media
through Hermes.

## Prerequisites

1. Confirm Node.js 22 or newer is available.
2. Confirm `ARTIFACTS_URL` and `ARTIFACTS_API_KEY` exist in the process
   environment without printing their values.
3. Keep the API key out of prompts, logs, command output, committed files, and
   agent instruction files.
4. Never use an admin or Cloudflare deployment credential for agent operations.

Read [references/operations.md](references/operations.md) only when scope,
retention, command arguments, or troubleshooting details are needed.
Read [references/hermes.md](references/hermes.md) when installing this skill into
Hermes Agent, configuring a remote Hermes VPS, or troubleshooting skill/env
discovery.

## How to Run

Invoke the bundled scripts through Hermes's `terminal` tool or the agent's
normal command runner. Resolve `AGENT_ARTIFACTS_SKILL_DIR` from this file before
running a command, and pass the source path explicitly.

## Quick Reference

### Store, retrieve, share, or delete an artifact

Use `scripts/artifactctl.mjs`.

```bash
node "$AGENT_ARTIFACTS_SKILL_DIR/scripts/artifactctl.mjs" upload ./screenshot.png --purpose pr-evidence --retention 7d
node "$AGENT_ARTIFACTS_SKILL_DIR/scripts/artifactctl.mjs" upload ./large-recording.mp4 --purpose pr-evidence --concurrency 3
# Resume an interrupted multipart upload from its local manifest.
node "$AGENT_ARTIFACTS_SKILL_DIR/scripts/artifactctl.mjs" upload ./large-recording.mp4 --resume
node "$AGENT_ARTIFACTS_SKILL_DIR/scripts/artifactctl.mjs" share ARTIFACT_ID --expires 604800
node "$AGENT_ARTIFACTS_SKILL_DIR/scripts/artifactctl.mjs" get ARTIFACT_ID --output ./download.png
node "$AGENT_ARTIFACTS_SKILL_DIR/scripts/artifactctl.mjs" delete ARTIFACT_ID
```

Upload first, parse the JSON response, and create a share only when another
person or system needs bearerless access. Use `7d` for disposable evidence,
`30d` for normal artifacts, and `retain` only when durable evidence is
intentional.

### Publish GitHub PR evidence

Use `scripts/github-pr-evidence.mjs`. Confirm `gh auth status` succeeds, then
run a dry run before the write unless the user explicitly asked to publish
immediately.

```bash
node "$AGENT_ARTIFACTS_SKILL_DIR/scripts/github-pr-evidence.mjs" --screenshot ./screenshot.png --video ./recording.mp4 --dry-run
node "$AGENT_ARTIFACTS_SKILL_DIR/scripts/github-pr-evidence.mjs" --screenshot ./screenshot.png --video ./recording.mp4
```

Pass `--pr NUMBER` when the current branch does not identify the target PR.
Set `GITHUB_REPOSITORY=OWNER/REPO` only when the current checkout does not
identify the repository. The script maintains one marked evidence comment and
cleans up replaced or failed uploads.

### Deliver media for Hermes

Use `scripts/hermes-gateway-media.mjs`.

```bash
node "$AGENT_ARTIFACTS_SKILL_DIR/scripts/hermes-gateway-media.mjs" ./recording.mp4 --ttl 604800
```

The script uploads with seven-day retention and returns a temporary share URL
that Hermes can include directly in its response or tool result.

## Procedure

1. Choose the narrowest operation and the shortest retention that satisfies the
   request.
2. Run the bundled script and parse its JSON result instead of scraping logs.
3. Create a share URL only when the recipient does not have API-key access.
4. Verify the returned ID, file metadata, expiry, or URL before reporting
   success.

## Pitfalls

- Direct artifact URLs require the scoped API key; share URLs are the
  bearerless delivery mechanism.
- Never use or expose an admin token, Cloudflare deployment credential, API key,
  or authorization header in output.
- Use `delete` only for an artifact the user identifies as disposable or asks
  to remove.

## Verification

For uploads and downloads, verify the script's JSON success and file metadata;
for shares, verify the returned URL and expiry. If a command fails, report its
failing stage and error instead of claiming that the artifact exists.

## Present results

Return the operation performed, artifact ID, filename, retention or expiry, and
share URL when one was created. Do not expose the API key or internal
authentication headers. If an operation fails, report the failing stage and the
script error; do not invent an artifact ID or URL.
