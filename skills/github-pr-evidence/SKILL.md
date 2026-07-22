---
name: github-pr-evidence
description: Upload screenshots or recordings and maintain one marked GitHub PR evidence comment.
required_environment_variables:
  - ARTIFACTS_URL
  - ARTIFACTS_API_KEY
---

Required environment variables: `ARTIFACTS_URL`, `ARTIFACTS_API_KEY`, and an authenticated `gh` CLI. Run from a checkout with an open PR, or pass `--pr NUMBER` and set `GITHUB_REPOSITORY=OWNER/REPO`.

```bash
node cli/github-pr-evidence.mjs --screenshot ./screenshot.png --video ./recording.mp4 --dry-run
node cli/github-pr-evidence.mjs --screenshot ./screenshot.png --video ./recording.mp4
```

The script updates the comment containing `<!-- agent-evidence:v1 -->` instead of creating duplicates. Screenshots are embedded as Markdown images; when both files are present, the screenshot is also the clickable video poster. Failed comment updates delete newly created artifacts, and a successful replacement deletes the previous evidence artifacts recorded in the comment marker.
