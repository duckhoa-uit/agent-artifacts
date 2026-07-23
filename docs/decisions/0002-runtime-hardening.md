# ADR 0002: Isolate untrusted delivery and serialize lifecycle transitions

Status: accepted

## Decision

- Uploaded active content is never rendered freely under the admin origin. Only
  inert raster, media, plain-text, and JSON types may preview inline; every
  artifact response carries a sandboxed CSP and unsafe types download as
  attachments.
- One Cloudflare Access application protects both admin destinations and yields
  one audience. The bootstrap reads the Zero Trust organization domain instead
  of deriving it from the Worker URL, and manages a Service Auth policy bound
  to the exact CI service token rather than accepting arbitrary service tokens.
- Multipart completion, abort, and cleanup claim explicit D1 transition state
  before calling R2. Interrupted completion is reconciled from the committed R2
  object, and failed aborts remain retryable.
- One-time key/share creation and their audit records commit in the same D1
  batch. R2-crossing operations use compensating deletion or retryable
  reconciliation.
- High-frequency usage metadata is coalesced, audit history is retained for 90
  days, and reconciled tombstones are purged after 30 days.

## Consequences

- HTML, SVG, JavaScript, PDF, and unknown artifact types download instead of
  opening in the admin browser.
- Access configuration has one source of truth: `ACCESS_TEAM_DOMAIN` and
  `ACCESS_AUDIENCE`.
- Upload state migrations must be applied before deploying the corresponding
  Worker version.
- Audit history remains operationally useful without growing D1 indefinitely.
