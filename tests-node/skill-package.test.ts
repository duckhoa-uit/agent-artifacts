import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skill = resolve(root, "skills/agent-artifacts");

describe("agent-artifacts skill package", () => {
  it("uses standard frontmatter plus Hermes setup metadata and bundles every referenced resource", async () => {
    const source = await readFile(resolve(skill, "SKILL.md"), "utf8");
    expect(source).toMatch(/^---\nname: agent-artifacts\n/);
    expect(source).toContain("description:");
    expect(source).toContain("compatibility:");
    expect(source).toContain("required_environment_variables:");
    expect(source).toContain("name: ARTIFACTS_URL");
    expect(source).toContain("name: ARTIFACTS_API_KEY");

    for (const path of [
      "scripts/artifactctl.mjs",
      "scripts/github-pr-evidence.mjs",
      "scripts/hermes-gateway-media.mjs",
      "references/operations.md",
      "references/hermes.md",
    ]) {
      expect(source).toContain(path);
      await expect(access(resolve(skill, path))).resolves.toBeUndefined();
    }
  });

  it("keeps root CLIs as thin delegates to the bundled scripts", async () => {
    for (const name of ["artifactctl", "github-pr-evidence", "hermes-gateway-media"]) {
      const source = await readFile(resolve(root, `cli/${name}.mjs`), "utf8");
      expect(source).toBe(`#!/usr/bin/env node\nimport "../skills/agent-artifacts/scripts/${name}.mjs";\n`);
    }
  });
});
