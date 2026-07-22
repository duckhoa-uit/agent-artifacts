# ADR 0001: Selective pattern reuse, clean implementation

Status: accepted

## Decision

Agent Artifacts is a clean TypeScript Worker implementation. It does not fork or copy source files from the reviewed upstream projects. It selectively applies proven architectural and UX patterns:

- CloudFlare-ImgBed: R2 multipart flow, HTTP Range delivery, and admin token management UX.
- PocketChest: stale multipart cleanup, artifact expiry, and integration-test emphasis.
- kotx/render: private object delivery behavior and conditional response semantics.
- pr-video: one marked GitHub PR comment that is updated instead of duplicated.

The security model is intentionally different: objects remain private, agent credentials are hash-only and owner-isolated, sharing is explicit, and the admin surface supports Cloudflare Access.

## Consequences

- Upstream fixes are evaluated and ported deliberately rather than inherited through a fork.
- There is no copied upstream code requiring bundled license text today. If source is adapted later, its exact commit, files, license, and notice must be recorded before merge.
- Behavior that matters to this service is covered by local Worker integration tests and deployed E2E tests.

## Reviewed sources

- CloudFlare-ImgBed, commit `6bc22cce1ead14aa2905a44bde9a7504284b7d14` (MIT)
- PocketChest, commit `5e1059e9700d876ca72471788ae42beaab6d56bd`
- kotx/render, commit `f6f2937981046ec6748d798f10c98b4054537964`
- Rahat-ch/pr-video, commit `8b3732bcabacd074484f42ab6297af6d84afa6ef`
