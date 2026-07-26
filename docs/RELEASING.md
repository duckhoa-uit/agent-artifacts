# Releasing

Agent Artifacts is private as an npm package but public as source and as the
`agent-artifacts` skill. Its package version is the repository release
identifier; it does not authorize `npm publish`.

`package.json` is the version source. The root entries in `package-lock.json`
and `skills/agent-artifacts/SKILL.md` metadata must match it. Skill validation
and Node tests enforce that relationship.

Before creating a release tag:

1. Complete and locally verify every change intended for the release.
2. Confirm required production migrations, deployment, and live E2E evidence.
3. Update the package, lockfile, and skill metadata to one version.
4. Run `npm test`, build, generated-type validation, skill validation, Worker
   startup analysis, and `git diff --check`.
5. Commit the clean release candidate, then create an annotated `vX.Y.Z` tag
   on that verified commit.

Keep the tag local until the operator separately authorizes pushing it or
creating a GitHub Release. A moving `main` installation and a pinned tag are
different support targets; record the commit or tag when reporting an installed
skill version.
