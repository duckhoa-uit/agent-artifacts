#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const screenshot = valueAfter("--screenshot");
const video = valueAfter("--video");
if (!screenshot && !video) fail("Provide --screenshot FILE and/or --video FILE");

const repo = process.env.GITHUB_REPOSITORY || (await ghJson(["repo", "view", "--json", "nameWithOwner"])).nameWithOwner;
const pr = valueAfter("--pr") || (await ghJson(["pr", "view", "--json", "number"])).number;
const cli = resolve(dirname(fileURLToPath(import.meta.url)), "artifactctl.mjs");
const evidence = [];
if (dryRun) {
  for (const item of [{ file: screenshot, kind: "screenshot" }, { file: video, kind: "video" }]) {
    if (item.file) evidence.push({ file: item.file, kind: item.kind, action: "upload-and-share" });
  }
  process.stdout.write(`${JSON.stringify({ dry_run: true, repo, pr, evidence }, null, 2)}\n`);
  process.exit(0);
}
for (const item of [{ file: screenshot, kind: "screenshot" }, { file: video, kind: "video" }]) {
  if (!item.file) continue;
  const uploaded = await run(process.execPath, [cli, "upload", item.file, "--purpose", "pr-evidence", "--source-agent", "github-pr-evidence", "--repo", repo, "--pr", String(pr)]);
  const artifact = JSON.parse(uploaded);
  const shared = JSON.parse(await run(process.execPath, [cli, "share", artifact.id, "--retention", "retain"]));
  evidence.push({ ...item, artifact_id: artifact.id, url: shared.url });
}

const body = ["<!-- agent-evidence:v1 -->", "### Agent evidence", ...evidence.map((item) => item.kind === "screenshot" ? `![${item.kind}](${item.url})` : `- [Open ${item.kind}](${item.url})`)].join("\n");
const comments = await ghJson(["api", "--paginate", `repos/${repo}/issues/${pr}/comments`]);
const existing = comments.find((comment) => comment.body?.includes("<!-- agent-evidence:v1 -->"));
if (existing) await gh(["api", "--method", "PATCH", `repos/${repo}/issues/comments/${existing.id}`, "-f", `body=${body}`]);
else await gh(["api", `repos/${repo}/issues/${pr}/comments`, "-f", `body=${body}`]);
process.stdout.write(`${JSON.stringify({ repo, pr, updated_comment: Boolean(existing), evidence })}\n`);

function valueAfter(flag) { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; }
function ghJson(parameters) { return gh(parameters).then((value) => JSON.parse(value)); }
function gh(parameters) { return run("gh", parameters); }
function run(command, parameters) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, parameters, { env: process.env });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => code === 0 ? resolvePromise(stdout) : reject(new Error(stderr || `${command} exited ${code}`)));
  });
}
function fail(message) { process.stderr.write(`${message}\n`); process.exit(1); }
