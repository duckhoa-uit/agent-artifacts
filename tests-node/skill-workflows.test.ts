import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const cli = resolve(root, "skills/agent-artifacts/scripts/artifactctl.mjs");
const githubEvidence = resolve(root, "skills/agent-artifacts/scripts/github-pr-evidence.mjs");
const hermesMedia = resolve(root, "skills/agent-artifacts/scripts/hermes-gateway-media.mjs");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("portable skill workflows", () => {
  it("refuses to send API credentials over non-loopback HTTP", async () => {
    await expect(run(process.execPath, [cli, "get", "art_1", "--output", "ignored"], {
      ...process.env,
      ARTIFACTS_URL: "http://artifacts.example",
      ARTIFACTS_API_KEY: "test-key",
    })).rejects.toThrow("ARTIFACTS_URL must use HTTPS");
  });

  it("executes multipart upload, share, download, and delete against the API contract", async () => {
    const fixture = await createFixture();
    try {
      const directory = await temporaryDirectory();
      const input = join(directory, "evidence.txt");
      const output = join(directory, "download.txt");
      await writeFile(input, "hello");

      const uploaded = JSON.parse(await run(process.execPath, [cli, "upload", input], fixture.env));
      expect(uploaded.id).toBe("art_1");
      expect(fixture.objects.get("art_1")?.toString()).toBe("hello");

      const shared = JSON.parse(await run(process.execPath, [cli, "share", uploaded.id], fixture.env));
      expect(shared.url).toContain("/s/");

      await run(process.execPath, [cli, "get", uploaded.id, "--output", output], fixture.env);
      expect(await readFile(output, "utf8")).toBe("hello");

      expect(JSON.parse(await run(process.execPath, [cli, "delete", uploaded.id], fixture.env))).toMatchObject({ deleted: true });
      expect(fixture.objects.has("art_1")).toBe(false);
    } finally {
      await fixture.close();
    }
  });

  it("handles paginated GitHub comments with --slurp and publishes evidence", async () => {
    const fixture = await createFixture();
    try {
      const directory = await temporaryDirectory();
      const bin = join(directory, "bin");
      const screenshot = join(directory, "screenshot.png");
      const calls = join(directory, "gh-calls.jsonl");
      await writeFile(screenshot, "image");
      await import("node:fs/promises").then(({ mkdir }) => mkdir(bin));
      const fakeGh = join(bin, "gh");
      await writeFile(fakeGh, `#!/usr/bin/env node
import { appendFile } from "node:fs/promises";
const args = process.argv.slice(2);
await appendFile(process.env.FAKE_GH_CALLS, JSON.stringify(args) + "\\n");
if (args[0] === "repo") console.log(JSON.stringify({ nameWithOwner: "owner/repo" }));
else if (args[0] === "pr") console.log(JSON.stringify({ number: 7 }));
else if (args[0] === "api" && args[1] === "user") console.log(JSON.stringify({ login: "trusted-bot" }));
else if (args.includes("--paginate")) console.log(JSON.stringify([[{ id: 10, user: { login: "attacker" }, body: "<!-- agent-evidence:v1 -->\\n<!-- agent-artifact-ids:art_00000000000000000000000000000000 -->" }], []]));
else console.log(JSON.stringify({ id: 1 }));
`);
      await chmod(fakeGh, 0o755);

      const output = JSON.parse(await run(process.execPath, [githubEvidence, "--screenshot", screenshot], {
        ...fixture.env,
        PATH: `${bin}${delimiter}${process.env.PATH}`,
        FAKE_GH_CALLS: calls,
        GITHUB_REPOSITORY: "",
      }));
      expect(output).toMatchObject({ repo: "owner/repo", pr: 7, updated_comment: false });
      const ghCalls = (await readFile(calls, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
      expect(ghCalls.some((args) => args.includes("--paginate") && args.includes("--slurp"))).toBe(true);
      expect(ghCalls.some((args) => args.includes("repos/owner/repo/issues/7/comments"))).toBe(true);
      expect(ghCalls.some((args) => args.includes("repos/owner/repo/issues/comments/10"))).toBe(false);
    } finally {
      await fixture.close();
    }
  });

  it("returns a share payload for Hermes without a second gateway integration", async () => {
    const fixture = await createFixture();
    try {
      const directory = await temporaryDirectory();
      const media = join(directory, "recording.mp4");
      await writeFile(media, "video");
      const output = JSON.parse(await run(process.execPath, [hermesMedia, media, "--ttl", "600"], fixture.env));
      expect(output).toMatchObject({ artifact_id: "art_1", url: expect.stringContaining("/s/") });
      expect(output).not.toHaveProperty("gateway_delivered");
    } finally {
      await fixture.close();
    }
  });
});

async function createFixture() {
  const objects = new Map<string, Buffer>();
  const uploads = new Map<string, { artifactId: string; parts: Map<number, Buffer> }>();
  let artifactSequence = 0;
  const server = createServer(async (request, response) => {
    try {
      await route(request, response);
    } catch (cause) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: String(cause) }));
    }
  });

  async function route(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? "/", "http://fixture");
    if (request.headers.authorization !== "Bearer test-key") return send(response, 401, { error: "unauthorized" });
    if (request.method === "GET" && url.pathname === "/v1/capabilities") {
      return send(response, 200, { max_small_upload_bytes: 1, multipart_part_size_bytes: 2 });
    }
    if (request.method === "POST" && url.pathname === "/v1/uploads") {
      const input = JSON.parse((await body(request)).toString());
      const artifactId = `art_${++artifactSequence}`;
      const uploadId = `upl_${artifactSequence}`;
      uploads.set(uploadId, { artifactId, parts: new Map() });
      return send(response, 201, { upload_id: uploadId, artifact_id: artifactId, part_size_bytes: 2, total_parts: Math.ceil(input.size_bytes / 2) });
    }
    const part = /^\/v1\/uploads\/([^/]+)\/parts\/(\d+)$/.exec(url.pathname);
    if (request.method === "PUT" && part) {
      uploads.get(part[1])?.parts.set(Number(part[2]), await body(request));
      return send(response, 200, { etag: `etag-${part[2]}` });
    }
    const complete = /^\/v1\/uploads\/([^/]+)\/complete$/.exec(url.pathname);
    if (request.method === "POST" && complete) {
      const upload = uploads.get(complete[1]);
      if (!upload) return send(response, 404, {});
      objects.set(upload.artifactId, Buffer.concat([...upload.parts.entries()].sort(([a], [b]) => a - b).map(([, value]) => value)));
      return send(response, 200, { id: upload.artifactId, filename: "evidence.txt", size_bytes: objects.get(upload.artifactId)?.length });
    }
    const share = /^\/v1\/artifacts\/([^/]+)\/shares$/.exec(url.pathname);
    if (request.method === "POST" && share) return send(response, 201, { id: "share_1", url: `http://fixture/s/token/${share[1]}` });
    const artifact = /^\/v1\/artifacts\/([^/]+)$/.exec(url.pathname);
    if (artifact && request.method === "GET") {
      const value = objects.get(artifact[1]);
      if (!value) return send(response, 404, {});
      response.writeHead(200, { "content-length": String(value.length) });
      return response.end(value);
    }
    if (artifact && request.method === "DELETE") {
      objects.delete(artifact[1]);
      response.writeHead(204);
      return response.end();
    }
    return send(response, 404, {});
  }

  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server did not bind");
  return {
    env: { ...process.env, ARTIFACTS_URL: `http://127.0.0.1:${address.port}`, ARTIFACTS_API_KEY: "test-key" },
    objects,
    close: () => new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise())),
  };
}

async function body(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function send(response: ServerResponse, status: number, payload: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agent-artifacts-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => code === 0 ? resolvePromise(stdout) : reject(new Error(stderr || `${command} exited ${code}`)));
  });
}
