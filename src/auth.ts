import { createRemoteJWKSet, jwtVerify } from "jose";
import type { AdminContext, AppEnv, AuthContext, Scope } from "./types";
import { authenticateApiKey, touchKey } from "./db";
import { error, sha256Bytes } from "./utils";

let cachedIssuer = "";
let cachedJwks: ReturnType<typeof createRemoteJWKSet> | undefined;

export async function requireScope(request: Request, env: AppEnv, ctx: ExecutionContext, scope: Scope): Promise<AuthContext | Response> {
  const token = bearer(request);
  if (!token) return error("Bearer API key required", 401, "unauthorized");
  const auth = await authenticateApiKey(env, token);
  if (!auth) return error("Invalid, expired, or revoked API key", 401, "unauthorized");
  ctx.waitUntil(touchKey(env, auth.id));
  if (!auth.scopes.includes(scope)) return error(`Missing scope: ${scope}`, 403, "forbidden");
  return auth;
}

export async function requireAdmin(request: Request, env: AppEnv): Promise<AdminContext | Response> {
  const accessToken = request.headers.get("cf-access-jwt-assertion");
  if (env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD && accessToken) {
    try {
      const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
      if (!cachedJwks || cachedIssuer !== issuer) {
        cachedIssuer = issuer;
        cachedJwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
      }
      const jwks = cachedJwks;
      const { payload } = await jwtVerify(accessToken, jwks, { issuer, audience: env.ACCESS_AUD });
      const actor = typeof payload.email === "string" ? payload.email : String(payload.sub ?? "access-user");
      return { actor, mode: "cloudflare-access" };
    } catch (cause) {
      console.warn(JSON.stringify({ event: "admin.access_denied", reason: cause instanceof Error ? cause.message : "invalid_jwt" }));
      return error("Cloudflare Access authentication failed", 401, "unauthorized");
    }
  }

  const token = bearer(request);
  if (token && env.ADMIN_TOKEN && await timingSafeTokenEqual(token, env.ADMIN_TOKEN)) {
    return { actor: "break-glass-admin", mode: "break-glass" };
  }
  return error("Admin authentication required", 401, "unauthorized");
}

export function accessConfigured(env: AppEnv): boolean {
  return Boolean(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD);
}

function bearer(request: Request): string | null {
  const value = request.headers.get("authorization");
  if (!value?.startsWith("Bearer ")) return null;
  const token = value.slice("Bearer ".length).trim();
  return token || null;
}

async function timingSafeTokenEqual(left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256Bytes(left), sha256Bytes(right)]);
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}
