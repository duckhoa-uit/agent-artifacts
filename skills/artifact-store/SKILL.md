---
name: artifact-store
description: Upload, retrieve, share, and delete agent artifacts through artifactctl.
required_environment_variables:
  - ARTIFACTS_URL
  - ARTIFACTS_API_KEY
---

Use the local `artifactctl` CLI. Required environment variables are `ARTIFACTS_URL` and `ARTIFACTS_API_KEY`; never put the raw key in a prompt, log, `TOOLS.md`, or this skill.

```bash
artifactctl upload ./screenshot.png --purpose pr-evidence
artifactctl upload ./recording.mp4 --purpose pr-evidence
artifactctl upload ./gateway-video.mp4 --purpose gateway-media --retention 7d
artifactctl share ARTIFACT_ID --retention retain
artifactctl get ARTIFACT_ID --output ./artifact.bin
artifactctl delete ARTIFACT_ID
```

The CLI emits one JSON object per successful operation. Large files automatically use the Worker multipart API.
