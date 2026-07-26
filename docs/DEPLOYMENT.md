# Deployment

This repository supports two different operational paths:

- maintain the existing production instance described by the committed
  `wrangler.jsonc`; or
- provision an independent instance in another Cloudflare account.

Do not mix the paths. The committed Worker name, R2 bucket name, D1
`database_name` and `database_id`, and `ACCESS_TEAM_DOMAIN` /
`ACCESS_AUDIENCE` values belong to the existing deployment. In particular, a
D1 database name is not an identity: Wrangler targets the configured
`database_id`.

Cloudflare credentials and Worker secrets must remain outside the repository.
The shared `.env.example` intentionally contains only the Worker URL used by
clients.

## Operate the existing production instance

The existing instance deploys only through the manually dispatched
`.github/workflows/deploy.yml` workflow. Do not change the production
`wrangler.jsonc` bindings as part of routine deployment.

Before dispatching the workflow, run these read-only checks from an
authenticated maintainer environment:

```bash
npx wrangler whoami --json
npx wrangler d1 list --json
npx wrangler r2 bucket list
npx wrangler secret list
node scripts/configure-access.mjs
gh repo view --json nameWithOwner,defaultBranchRef
gh api repos/duckhoa-uit/agent-artifacts/environments/production --jq '.name'
git diff --quiet -- wrangler.jsonc
git diff --cached --quiet -- wrangler.jsonc
```

Confirm all of the following before allowing any remote write:

- Wrangler is authenticated to the intended Cloudflare account.
- The configured D1 `database_name` and `database_id` identify the same
  database returned by `wrangler d1 list`.
- The configured R2 `bucket_name` appears in `wrangler r2 bucket list`.
- `wrangler secret list` includes the required `ADMIN_TOKEN` name. The command
  lists names and types only; do not print the value.
- The Access helper's dry-run result matches the committed
  `ACCESS_TEAM_DOMAIN`, `ACCESS_AUDIENCE`, Worker hostname, administrator
  policy, and CI service-token policy. Omit `--apply` during preflight.
- `gh` is targeting this repository and its `production` environment.
- Both `git diff` checks exit zero, so `wrangler.jsonc` has neither staged nor
  unstaged changes.

Dispatch the `Deploy` workflow only after the preflight passes. It intentionally
runs build, generated-type validation, tests, skill validation, and startup
analysis before `npm run db:migrate:remote`; deployment follows the migration,
and live E2E runs last. Do not run the deploy step ahead of its migration.

## Provision a separate instance

Use a dedicated branch or fork for the new deployment configuration. Never
edit the existing production bindings merely to run exploratory commands.

### 1. Select the target account and create resources

Authenticate Wrangler to the intended Cloudflare account and verify the
selection before creating anything:

```bash
npx wrangler whoami --json
npx wrangler r2 bucket create NEW_PRIVATE_BUCKET
npx wrangler d1 create NEW_DATABASE
```

Keep the R2 bucket private. Record the D1 binding block returned by
`wrangler d1 create`; it contains the new database's unique ID but no
credential.

### 2. Replace every deployment-specific value

In the new branch or fork, update `wrangler.jsonc`:

- choose a new top-level `name` for the Worker;
- keep the binding name `ARTIFACTS`, but replace its `bucket_name` with
  `NEW_PRIVATE_BUCKET`;
- keep the binding name `DB` and `migrations_dir`, but replace both
  `database_name` and `database_id` with the values returned for
  `NEW_DATABASE`;
- replace `ACCESS_TEAM_DOMAIN` and `ACCESS_AUDIENCE` with values from the new
  Access application.

Do not change the binding names used by the Worker, add credentials to
`wrangler.jsonc`, or copy the existing account's D1 or Access values into the
new instance.

### 3. Configure Cloudflare Access

Create an Access service token for CI in the target account. Give the temporary
provisioning API token only these setup permissions:

- `Access: Apps and Policies Write`;
- `Access: Organizations, Identity Providers, and Groups Read`;
- `Access: Service Tokens Read`.

Provide the setup values through the operator environment, not a committed
file. The helper does not need the service-token secret:

```bash
export CLOUDFLARE_ACCOUNT_ID=TARGET_ACCOUNT_ID
export CLOUDFLARE_API_TOKEN
export ARTIFACTS_URL=https://NEW_WORKER.NEW_SUBDOMAIN.workers.dev
export ACCESS_ALLOWED_EMAIL=ADMINISTRATOR_EMAIL
export ARTIFACTS_E2E_ACCESS_CLIENT_ID=SERVICE_TOKEN_CLIENT_ID
node scripts/configure-access.mjs
node scripts/configure-access.mjs --apply
```

Run once without `--apply` and review the proposed destinations and policies.
The apply command creates or updates one self-hosted application covering
`/admin*` and `/v1/admin/*`, an administrator email policy, and a Service Auth
policy restricted to the selected CI token. Copy only the returned Access team
domain and audience into `wrangler.jsonc`; never copy the provisioning token or
service-token secret.

Store the service-token client ID and secret only in the CI environment that
runs post-deploy E2E. Revoke the temporary provisioning token after Access
setup.

### 4. Run the read-only preflight

Do not migrate or deploy until every check agrees with the new configuration:

```bash
npx wrangler whoami --json
npx wrangler d1 list --json
npx wrangler r2 bucket list
node scripts/configure-access.mjs
npm run build
npm run types:check
npm run check
git diff --check
```

Verify:

- the selected account is the new target account;
- the configured D1 name and ID are the same entry in `d1 list`;
- the configured private R2 bucket exists in that account;
- the Access dry run finds the new Worker hostname and returns the same domain
  and audience now stored in `wrangler.jsonc`;
- the Worker name and client-facing `ARTIFACTS_URL` describe the same target;
- build, binding types, startup analysis, and documentation checks pass.

If the fork will use GitHub Actions, also create its own `production`
environment and confirm it read-only before dispatch:

```bash
gh repo view --json nameWithOwner,defaultBranchRef
gh api repos/OWNER/REPOSITORY/environments/production --jq '.name'
```

Set that environment's Cloudflare account/API credentials, Access E2E
service-token pair, and `ARTIFACTS_URL` to the new instance. Never reuse the
existing repository's deployment environment.

### 5. Migrate, configure the required secret, and deploy

Apply all D1 migrations before the application code:

```bash
npm run db:migrate:remote
```

The Worker declares `ADMIN_TOKEN` as required, so a first deployment cannot
succeed until that secret is supplied. Keep a secrets file outside the
repository with owner-only permissions, then upload it atomically with the
first deployment:

```bash
npm run deploy -- --secrets-file /absolute/path/outside/repository/secrets.env
```

The external file must define the `ADMIN_TOKEN` credential. Do not show its
value in terminal history, logs, documentation, or chat, and never add the file
to this repository. For an already deployed instance, rotate the secret
interactively instead:

```bash
npx wrangler secret put ADMIN_TOKEN
```

Finally, run deployed E2E with the new instance's `ARTIFACTS_URL` and its own
Access service-token pair. E2E must not run against the existing production
Worker when validating a separate instance.

## Maintenance checklist

Whenever the Worker name, D1/R2 bindings, Access destinations, required
secrets, or deployment workflow changes:

1. update both deployment paths together;
2. keep migration before deployment;
3. keep preflight commands read-only;
4. confirm `.env.example` still contains no shared credential; and
5. validate that no example config can be mistaken for production-ready
   bindings.
