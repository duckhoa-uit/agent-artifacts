import { createArtifactShare, createSmallArtifact, completeMultipart, deleteArtifact, getArtifactResponse, getSharedArtifact, initMultipart, revokeShare, uploadPart, abortMultipart } from "./artifacts";
import { issueApiKey, listApiKeys, revokeApiKey, updateApiKey } from "./admin";
import type { AppEnv } from "./types";
import { error, json } from "./utils";

export default {
  async fetch(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
    try {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/$/, "") || "/";
      let response: Response;
      if (path === "/healthz" && request.method === "GET") {
        response = json({ ok: true, service: "agent-artifacts", environment: env.ENVIRONMENT });
      } else if (path === "/v1/artifacts" && request.method === "POST") {
        response = await createSmallArtifact(request, env, ctx);
      } else if (path === "/v1/uploads" && request.method === "POST") {
        response = await initMultipart(request, env, ctx);
      } else if (path.startsWith("/v1/uploads/") && path.endsWith("/complete") && request.method === "POST") {
        response = await completeMultipart(request, env, ctx, path.split("/")[3]);
      } else if (path.startsWith("/v1/uploads/") && request.method === "DELETE") {
        response = await abortMultipart(request, env, ctx, path.split("/")[3]);
      } else if (path.startsWith("/v1/uploads/") && path.includes("/parts/") && request.method === "PUT") {
        const segments = path.split("/");
        response = await uploadPart(request, env, ctx, segments[3], segments[5]);
      } else if (path.startsWith("/v1/artifacts/") && path.endsWith("/shares") && request.method === "POST") {
        response = await createArtifactShare(request, env, ctx, path.split("/")[3]);
      } else if (path.startsWith("/v1/artifacts/") && request.method === "GET") {
        response = await getArtifactResponse(request, env, ctx, path.split("/")[3]);
      } else if (path.startsWith("/v1/artifacts/") && request.method === "HEAD") {
        response = await getArtifactResponse(request, env, ctx, path.split("/")[3]);
      } else if (path.startsWith("/v1/artifacts/") && request.method === "DELETE") {
        response = await deleteArtifact(request, env, ctx, path.split("/")[3]);
      } else if (path.startsWith("/v1/shares/") && request.method === "DELETE") {
        response = await revokeShare(request, env, ctx, path.split("/")[3]);
      } else if (path === "/v1/admin/api-keys" && request.method === "GET") {
        response = await listApiKeys(request, env);
      } else if (path === "/v1/admin/api-keys" && request.method === "POST") {
        response = await issueApiKey(request, env);
      } else if (path.startsWith("/v1/admin/api-keys/") && request.method === "PATCH") {
        response = await updateApiKey(request, env, path.split("/")[4]);
      } else if (path.startsWith("/v1/admin/api-keys/") && request.method === "DELETE") {
        response = await revokeApiKey(request, env, path.split("/")[4]);
      } else if (path.startsWith("/s/") && (request.method === "GET" || request.method === "HEAD")) {
        response = await getSharedArtifact(request, env, ctx, path.split("/")[2]);
      } else {
        response = error("Route not found", 404, "not_found");
      }
      return withCors(response);
    } catch (cause) {
      console.error(JSON.stringify({ event: "request.error", message: cause instanceof Error ? cause.message : String(cause) }));
      return withCors(error("Internal server error", 500, "internal_error"));
    }
  },
};

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders())) headers.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, content-type, range, x-filename, x-artifact-sha256, x-source-agent, x-repo, x-pr-number, x-task-id, x-purpose",
    "access-control-allow-methods": "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS",
  };
}
