#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const [file, ...args] = process.argv.slice(2);
if (!file) { process.stderr.write("Usage: hermes-gateway-media FILE [--ttl SECONDS]\n"); process.exit(1); }
const ttlIndex = args.indexOf("--ttl");
const ttl = ttlIndex >= 0 ? args[ttlIndex + 1] : "604800";
const cli = resolve(dirname(fileURLToPath(import.meta.url)), "artifactctl.mjs");
const artifact = JSON.parse(await run(process.execPath, [cli, "upload", file, "--purpose", "gateway-media", "--source-agent", "hermes-gateway"]));
const share = JSON.parse(await run(process.execPath, [cli, "share", artifact.id, "--expires", ttl]));
process.stdout.write(`${JSON.stringify({ artifact_id: artifact.id, filename: artifact.filename, size_bytes: artifact.size_bytes, sha256: artifact.sha256, url: share.url, expires_at: share.expires_at })}\n`);

function run(command, parameters) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, parameters, { env: process.env });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => code === 0 ? resolvePromise(stdout) : reject(new Error(stderr || `${command} exited ${code}`)));
  });
}
