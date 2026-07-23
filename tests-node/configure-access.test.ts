import { describe, expect, it, vi } from "vitest";
import { configureAccess } from "../scripts/configure-access.mjs";

describe("Cloudflare Access bootstrap", () => {
  it("creates one application with both destinations and unwraps API results", async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path: url.pathname, body });

      if (method === "GET" && url.pathname.endsWith("/access/apps")) return response([]);
      if (method === "GET" && url.pathname.endsWith("/access/organizations")) return response({ auth_domain: "team.cloudflareaccess.com" });
      if (method === "GET" && url.pathname.endsWith("/access/service_tokens")) {
        return response([{ id: "service_1", name: "agent-artifacts-ci", client_id: "client.access" }]);
      }
      if (method === "POST" && url.pathname.endsWith("/access/apps")) {
        return response({ id: "app_1", aud: "aud_1", destinations: body.destinations });
      }
      if (method === "GET" && url.pathname.endsWith("/access/apps/app_1/policies")) return response([]);
      if (method === "POST" && url.pathname.endsWith("/access/apps/app_1/policies")) return response({ id: "policy_1" });
      return new Response(JSON.stringify({ success: false, errors: [{ message: "unexpected request" }] }), { status: 404 });
    });

    const result = await configureAccess({
      accountId: "account",
      token: "token",
      artifactsUrl: "https://artifacts.example.test",
      allowedEmail: "admin@example.test",
      serviceTokenClientId: "client.access",
      apply: true,
      fetchImpl,
      log: vi.fn(),
    });

    expect(result).toMatchObject({
      configured: true,
      access_team_domain: "team.cloudflareaccess.com",
      access_audience: "aud_1",
      service_auth: "managed",
    });
    expect(calls).not.toContainEqual(expect.objectContaining({ path: expect.stringContaining("undefined") }));
    expect(calls.find((call) => call.method === "POST" && call.path.endsWith("/access/apps"))?.body).toMatchObject({
      destinations: [
        { type: "public", uri: "artifacts.example.test/admin*" },
        { type: "public", uri: "artifacts.example.test/v1/admin/*" },
      ],
    });
    expect(calls).toContainEqual(expect.objectContaining({
      method: "POST",
      path: expect.stringMatching(/\/access\/apps\/app_1\/policies$/),
      body: {
        name: "service-agent-artifacts-e2e",
        decision: "service_auth",
        include: [{ service_token: { token_id: "service_1" } }],
      },
    }));
  });

  it("reuses an existing application and reports dry-run actions without writes", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/access/apps")) {
        return response([{
          id: "app_existing",
          aud: "aud_existing",
          destinations: [
            { type: "public", uri: "artifacts.example.test/admin*" },
            { type: "public", uri: "artifacts.example.test/v1/admin/*" },
          ],
        }]);
      }
      if (url.pathname.endsWith("/access/organizations")) return response({ auth_domain: "team.cloudflareaccess.com" });
      if (url.pathname.endsWith("/access/apps/app_existing/policies")) return response([]);
      return new Response(null, { status: 404 });
    });
    const log = vi.fn();

    const result = await configureAccess({
      accountId: "account",
      token: "token",
      artifactsUrl: "https://artifacts.example.test",
      allowedEmail: "admin@example.test",
      fetchImpl,
      log,
    });

    expect(result.access_audience).toBe("aud_existing");
    expect(fetchImpl.mock.calls.every(([, init]) => (init?.method ?? "GET") === "GET")).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("create-policy"));
  });

  it("rotates the managed Service Auth policy to the requested service token", async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path: url.pathname, body });

      if (url.pathname.endsWith("/access/apps")) {
        return response([{
          id: "app_existing",
          aud: "aud_existing",
          destinations: [
            { type: "public", uri: "artifacts.example.test/admin*" },
            { type: "public", uri: "artifacts.example.test/v1/admin/*" },
          ],
        }]);
      }
      if (url.pathname.endsWith("/access/organizations")) return response({ auth_domain: "team.cloudflareaccess.com" });
      if (url.pathname.endsWith("/access/service_tokens")) {
        return response([{ id: "service_new", name: "agent-artifacts-ci", client_id: "new.access" }]);
      }
      if (url.pathname.endsWith("/access/apps/app_existing/policies")) {
        return response([
          {
            id: "email_policy",
            name: "Allow admin@example.test",
            decision: "allow",
            include: [{ email: { email: "admin@example.test" } }],
          },
          {
            id: "service_policy",
            name: "service-agent-artifacts-e2e",
            decision: "service_auth",
            include: [{ service_token: { token_id: "service_old" } }],
          },
        ]);
      }
      if (method === "PUT" && url.pathname.endsWith("/access/apps/app_existing/policies/service_policy")) {
        return response({ id: "service_policy", ...body });
      }
      return new Response(null, { status: 404 });
    });

    await configureAccess({
      accountId: "account",
      token: "token",
      artifactsUrl: "https://artifacts.example.test",
      allowedEmail: "admin@example.test",
      serviceTokenClientId: "new.access",
      apply: true,
      fetchImpl,
      log: vi.fn(),
    });

    expect(calls).toContainEqual({
      method: "PUT",
      path: "/client/v4/accounts/account/access/apps/app_existing/policies/service_policy",
      body: {
        name: "service-agent-artifacts-e2e",
        decision: "service_auth",
        include: [{ service_token: { token_id: "service_new" } }],
      },
    });
  });
});

function response(result: unknown): Response {
  return Response.json({ success: true, result });
}
