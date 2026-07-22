---
name: hermes-gateway-media
description: Upload media for Hermes gateway delivery and return a temporary share URL.
---

Required environment variables: `ARTIFACTS_URL` and the profile-scoped `ARTIFACTS_API_KEY`.

```bash
node cli/hermes-gateway-media.mjs ./recording.mp4 --ttl 604800
```

The command returns JSON with artifact metadata, SHA-256, URL, and expiry. The gateway may download the URL and attach the binary when its destination supports direct attachments.
