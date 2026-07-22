import { abortMultipart, completeMultipart, createArtifactShare, createSmallArtifact, deleteArtifact, getArtifactResponse, getSharedArtifact, initMultipart, revokeShare, uploadPart } from "./artifacts";
import { handleAdmin } from "./admin";
import { accessConfigured, requireAdmin } from "./auth";
import { runCleanup } from "./cleanup";
import type { AppEnv } from "./types";
import { error, json } from "./utils";

export default {
  async fetch(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
    const requestId = crypto.randomUUID();
    try {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/$/, "") || "/";
      if (request.method === "OPTIONS") return preflight(request, env);

      if (path === "/admin" || path.startsWith("/admin/")) {
        if (accessConfigured(env)) {
          const admin = await requireAdmin(request, env);
          if (admin instanceof Response) return withRequestId(admin, requestId);
        }
        return withRequestId(await env.ASSETS.fetch(request), requestId);
      }

      let response: Response;
      if (path === "/healthz" && request.method === "GET") {
        response = json({ ok: true, service: "agent-artifacts", environment: env.ENVIRONMENT });
      } else if (path.startsWith("/v1/admin/")) {
        const admin = await requireAdmin(request, env);
        response = admin instanceof Response ? admin : await handleAdmin(request, env, admin, path);
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
      } else if (path.startsWith("/v1/artifacts/") && (request.method === "GET" || request.method === "HEAD")) {
        response = await getArtifactResponse(request, env, ctx, path.split("/")[3]);
      } else if (path.startsWith("/v1/artifacts/") && request.method === "DELETE") {
        response = await deleteArtifact(request, env, ctx, path.split("/")[3]);
      } else if (path.startsWith("/v1/shares/") && request.method === "DELETE") {
        response = await revokeShare(request, env, ctx, path.split("/")[3]);
      } else if (path.startsWith("/s/") && (request.method === "GET" || request.method === "HEAD")) {
        response = await getSharedArtifact(request, env, ctx, path.split("/")[2]);
      } else {
        response = error("Route not found", 404, "not_found");
      }
      return withCors(withRequestId(response, requestId), request, env);
    } catch (cause) {
      console.error(JSON.stringify({ event: "request.error", request_id: requestId, message: cause instanceof Error ? cause.message : String(cause) }));
      return withRequestId(error("Internal server error", 500, "internal_error"), requestId);
    }
  },

  async scheduled(_controller: ScheduledController, env: AppEnv, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCleanup(env).then((result) => console.log(JSON.stringify({ event: "cleanup.complete", ...result }))));
  },
};

function withRequestId(response: Response, requestId: string): Response {
  const headers = new Headers(response.headers);
  headers.set("x-request-id", requestId);
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-frame-options", "DENY");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  headers.set("content-security-policy", "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; img-src 'self' blob: data:; object-src 'none'");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function withCors(response: Response, request: Request, env: AppEnv): Response {
  const origin = request.headers.get("origin");
  if (!origin || !env.CORS_ORIGIN || origin !== env.CORS_ORIGIN) return response;
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  headers.set("vary", "Origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function preflight(request: Request, env: AppEnv): Response {
  const origin = request.headers.get("origin");
  if (!origin || !env.CORS_ORIGIN || origin !== env.CORS_ORIGIN) return new Response(null, { status: 403 });
  return new Response(null, { status: 204, headers: {
    "access-control-allow-origin": origin,
    "access-control-allow-headers": "authorization, content-type, range, x-filename, x-artifact-sha256, x-artifact-retention, x-source-agent, x-repo, x-pr-number, x-task-id, x-purpose",
    "access-control-allow-methods": "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS",
    "access-control-max-age": "86400",
    vary: "Origin",
  } });
}
