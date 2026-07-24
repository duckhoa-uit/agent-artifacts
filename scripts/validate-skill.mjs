#!/usr/bin/env node

import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

const tempRoot = await mkdtemp(join(tmpdir(), "agent-artifacts-skill-"));
const tempSkillDir = join(tempRoot, "agent-artifacts");

try {
  await cp(skillDir, tempSkillDir, { recursive: true });
  const skillPath = join(tempSkillDir, "SKILL.md");
  const source = await readFile(skillPath, "utf8");
  await writeFile(skillPath, withoutHermesExtensions(source));

  await new Promise((resolvePromise, reject) => {
    execFile(process.execPath, [standardValidator, "validate", tempSkillDir], (error, stdout, stderr) => {
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
      if (error) reject(error);
      else resolvePromise();
    });
  });

  console.log("Hermes frontmatter extensions preserved; standard Agent Skills validation passed.");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
