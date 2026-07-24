# Hermes Agent distribution

Install the skill on the machine that runs Hermes. Do not copy a skill from
another workstation or rely on a local symlink when Hermes is running on a
separate VPS.

For a Hermes-only VPS, prefer Hermes's native Skills Hub/custom-tap flow. Use
the `npx skills` flow when the same release must be installed into several
agent runtimes.

## Native Hermes installation

From the VPS, run as the same user that runs Hermes:

```bash
hermes skills tap add duckhoa-uit/agent-artifacts
hermes skills install duckhoa-uit/agent-artifacts/agent-artifacts
```

The public repository installs without a GitHub credential.

Verify the source and installation, then check for updates:

```bash
hermes skills list --source hub
hermes skills check
hermes skills update agent-artifacts
test -f ~/.hermes/skills/agent-artifacts/SKILL.md
```

The native installer records provenance/content state and downloads the
referenced `scripts/` and `references/` resources alongside `SKILL.md`.

## Cross-agent installation with `npx skills`

Use this route when standardizing installation across Codex, Claude Code, and
Hermes Agent:

```bash
npx skills add https://github.com/duckhoa-uit/agent-artifacts.git \
  --skill agent-artifacts \
  --global \
  --agent hermes-agent \
  --yes
```

The installer places the skill in Hermes's global skill directory and includes
the `SKILL.md` plus the referenced `scripts/` and `references/` files. Hermes
records the installed source and content hash in its skill lock/audit state.
The VPS does not need the Agent Artifacts repository after installation.

Verify the install:

```bash
npx skills list --global --agent hermes-agent
test -f ~/.hermes/skills/agent-artifacts/SKILL.md
```

After installation, restart Hermes or start a new session with `/reset` so the
skill index is rebuilt.

## Profile-scoped runtime configuration

Create a separate Agent Artifacts API key for each Hermes profile. Grant only
the scopes that profile needs:

- `artifact:write` to upload;
- `artifact:read` to download or inspect owned artifacts;
- `share:create` to return bearerless share links;
- `artifact:delete` only when Hermes is explicitly responsible for cleanup.

Store the endpoint and key in the Hermes profile environment, for example:

```env
ARTIFACTS_URL=https://agent-artifacts.duckhoa-dev.workers.dev
ARTIFACTS_API_KEY=ak_live_...
```

Keep the profile environment readable only by the Hermes service user. Do not
put the key in `config.yaml`, a skill file, a repository, or a chat prompt.
The `required_environment_variables` in the skill frontmatter allow Hermes to
securely request missing values when the skill is loaded and pass them to the
terminal/execute-code sandbox. Messaging gateways should direct setup to the
VPS environment rather than asking for secrets in chat.

Use `synthetic` only for disposable smoke/E2E keys. Normal Hermes traffic must
use a non-synthetic key so production analytics include it.

## Hermes usage

For a normal upload, Hermes should load this skill and run the bundled CLI with
the source file path, a meaningful purpose, the intended retention, and
`--source-agent hermes`. Create a share only when the recipient needs access
without an API key. Direct artifact downloads remain authenticated.

Example workflow:

```bash
node "$AGENT_ARTIFACTS_SKILL_DIR/scripts/artifactctl.mjs" \
  upload ./output.zip \
  --purpose hermes-delivery \
  --retention 7d \
  --source-agent hermes

node "$AGENT_ARTIFACTS_SKILL_DIR/scripts/artifactctl.mjs" \
  share ARTIFACT_ID --expires 604800
```

Return the artifact ID, filename, retention/expiry, and share URL when one was
created. Never return the API key or authorization headers.

## Updating the distribution

After a verified change is pushed to GitHub, update an `npx skills` installation:

```bash
npx skills update agent-artifacts --global --yes
```

For a native Hermes installation, use `hermes skills check` followed by
`hermes skills update agent-artifacts`.

For a pinned release, install from a tagged repository ref or a reviewed commit
using the same `npx skills add` flow. Keep the skill source and the Hermes
profile secrets as separate release concerns.
