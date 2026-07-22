---
name: hermes-gateway-media
description: Upload media for Hermes gateway delivery and return a temporary share URL.
required_environment_variables:
  - ARTIFACTS_URL
  - ARTIFACTS_API_KEY
---

Required environment variables: `ARTIFACTS_URL` and the profile-scoped `ARTIFACTS_API_KEY`.

```bash
node cli/hermes-gateway-media.mjs ./recording.mp4 --ttl 604800
```

The command returns JSON with artifact metadata, SHA-256, URL, and expiry. If `HERMES_GATEWAY_MEDIA_URL` is set, it posts that payload to the gateway and optionally authenticates with `HERMES_GATEWAY_TOKEN`. Failed share or gateway delivery deletes the newly created artifact.
