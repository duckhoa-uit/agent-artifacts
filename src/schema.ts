import { z } from "zod";
import { AGENT_SCOPES } from "./types";

const optionalText = z.string().trim().max(500).optional();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/i, "sha256 must be 64 hexadecimal characters").transform((value) => value.toLowerCase());

export const retentionSchema = z.enum(["7d", "30d", "retain"]);
export const scopeSchema = z.enum(AGENT_SCOPES);

export const artifactInputSchema = z.object({
  filename: z.string().trim().min(1).max(240),
  content_type: z.string().trim().min(1).max(255).default("application/octet-stream"),
  sha256: sha256.optional(),
  source_agent: optionalText,
  repo: optionalText,
  pr_number: z.coerce.number().int().positive().optional(),
  task_id: optionalText,
  purpose: optionalText,
  retention: retentionSchema.optional(),
});

export const multipartInputSchema = artifactInputSchema.extend({
  size_bytes: z.coerce.number().int().positive(),
  sha256,
});

export const shareInputSchema = z.object({
  expires_in_seconds: z.coerce.number().int().positive().max(31_536_000).optional(),
  retention: z.enum(["retain", "temporary"]).default("temporary"),
});

export const createKeySchema = z.object({
  owner: z.string().trim().min(1).max(200),
  scopes: z.array(scopeSchema).min(1).default([...AGENT_SCOPES]),
  synthetic: z.boolean().default(false),
  expires_in_seconds: z.coerce.number().int().positive().max(31_536_000).optional(),
  expires_at: z.number().int().positive().nullable().optional(),
});

export const updateKeySchema = z.object({
  scopes: z.array(scopeSchema).min(1).optional(),
  expires_at: z.number().int().positive().nullable().optional(),
  revoked: z.boolean().optional(),
}).refine((body) => Object.keys(body).length > 0, "At least one supported field is required");

export const adminShareSchema = shareInputSchema.extend({
  artifact_id: z.string().min(1),
});

export async function parseJson<T>(request: Request, schema: z.ZodType<T>): Promise<{ data: T } | { response: Response }> {
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    return { response: new Response(JSON.stringify({ error: { code: "unsupported_media_type", message: "Content-Type must be application/json" } }), {
      status: 415,
      headers: { "content-type": "application/json; charset=utf-8" },
    }) };
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { response: validationError("Request body must be valid JSON") };
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return { response: validationError(parsed.error.issues.map((issue) => issue.message).join("; ")) };
  return { data: parsed.data };
}

function validationError(message: string): Response {
  return new Response(JSON.stringify({ error: { code: "validation_error", message } }), {
    status: 400,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
