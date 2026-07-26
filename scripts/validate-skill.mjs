#!/usr/bin/env node

import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillDir = join(root, "skills", "agent-artifacts");
const standardValidator = join(root, "node_modules", "skills-ref", "dist", "cli.js");

function withoutHermesExtensions(source) {
  const lines = source.split("\n");
  const output = [];
  let skipping = false;

  for (const line of lines) {
    if (line === "required_environment_variables:") {
      skipping = true;
      continue;
    }
    if (skipping && line.length > 0 && !/^\s/.test(line)) skipping = false;
    if (!skipping) output.push(line);
  }

  return output.join("\n");
}

export function assertReleaseVersion(packageVersion, skillSource) {
  const frontmatter = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(skillSource)?.[1];
  if (!frontmatter) throw new Error("Skill frontmatter is missing");

  let inMetadata = false;
  let skillVersion;
  for (const line of frontmatter.split("\n")) {
    if (line === "metadata:") {
      inMetadata = true;
      continue;
    }
    if (inMetadata && line.length > 0 && !line.startsWith("  ")) break;
    const match = inMetadata ? /^  version:\s*["']?([^"'\s]+)["']?\s*$/.exec(line) : null;
    if (match) {
      skillVersion = match[1];
      break;
    }
  }
  if (!skillVersion) throw new Error("Skill metadata.version is missing");
  if (packageVersion !== skillVersion) {
    throw new Error(`Release version mismatch: package.json=${packageVersion}, skill=${skillVersion}`);
  }
  return skillVersion;
}

async function validateSkill() {
  const sourceSkillPath = join(skillDir, "SKILL.md");
  const [source, packageSource] = await Promise.all([
    readFile(sourceSkillPath, "utf8"),
    readFile(join(root, "package.json"), "utf8"),
  ]);
  const releaseVersion = assertReleaseVersion(JSON.parse(packageSource).version, source);
  const tempRoot = await mkdtemp(join(tmpdir(), "agent-artifacts-skill-"));
  const tempSkillDir = join(tempRoot, "agent-artifacts");

  try {
    await cp(skillDir, tempSkillDir, { recursive: true });
    const skillPath = join(tempSkillDir, "SKILL.md");
    await writeFile(skillPath, withoutHermesExtensions(source));

    await new Promise((resolvePromise, reject) => {
      execFile(process.execPath, [standardValidator, "validate", tempSkillDir], (error, stdout, stderr) => {
        if (stdout) process.stdout.write(stdout);
        if (stderr) process.stderr.write(stderr);
        if (error) reject(error);
        else resolvePromise();
      });
    });

    console.log(`Release metadata aligned at ${releaseVersion}; Hermes frontmatter extensions preserved; standard Agent Skills validation passed.`);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  validateSkill().catch((cause) => {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exitCode = 1;
  });
}
