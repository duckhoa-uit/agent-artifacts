import type { AppEnv, AuthContext, Scope } from "./types";
import { authenticateApiKey, touchKey } from "./db";
import { error } from "./utils";

export async function requireScope(request: Request, env: AppEnv, ctx: ExecutionContext, scope: Scope): Promise<AuthContext | Response> {
  const token = bearer(request);
  if (!token) return error("Bearer API key required", 401, "unauthorized");
  const auth = await authenticateApiKey(env, token);
  if (!auth) return error("Invalid, expired, or revoked API key", 401, "unauthorized");
  ctx.waitUntil(touchKey(env, auth.id));
  if (!auth.scopes.includes(scope)) return error(`Missing scope: ${scope}`, 403, "forbidden");
  return auth;
}

export function requireAdmin(request: Request, env: AppEnv): Response | null {
  const token = bearer(request);
  if (!token || !env.ADMIN_TOKEN || !constantTime(token, env.ADMIN_TOKEN)) return error("Admin authentication required", 401, "unauthorized");
  return null;
}

function bearer(request: Request): string | null {
  const value = request.headers.get("authorization");
  if (!value?.startsWith("Bearer ")) return null;
  const token = value.slice("Bearer ".length).trim();
  return token || null;
}

function constantTime(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let result = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) result |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return result === 0;
}
