const encoder = new TextEncoder();

export function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

export function error(message: string, status = 400, code = "bad_request"): Response {
  return json({ error: { code, message } }, status);
}

export function now(): number {
  return Math.floor(Date.now() / 1000);
}

export function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

export function randomToken(prefix: string): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `${prefix}_${base64url(bytes)}`;
}

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return hex(new Uint8Array(digest));
}

export function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function constantTimeEqual(left: string, right: string): boolean {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  let result = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) result |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return result === 0;
}

export function safeFilename(value: string | null | undefined): string {
  const cleaned = (value ?? "artifact").replace(/[\\/\0\r\n]/g, "_").trim();
  return cleaned.slice(0, 240) || "artifact";
}

export function parseJsonBody<T>(request: Request): Promise<T> {
  return request.json() as Promise<T>;
}

export function parsePositiveInt(value: unknown, fallback?: number): number | undefined {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function parseRange(value: string | null, size: number): { offset: number; length: number } | null {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isInteger(suffix) || suffix <= 0) return null;
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }
  const offset = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isInteger(offset) || !Number.isInteger(end) || offset < 0 || end < offset || offset >= size) return null;
  return { offset, length: Math.min(end, size - 1) - offset + 1 };
}

export function artifactHeaders(artifact: { filename: string; content_type: string; size_bytes: number; sha256?: string | null }, etag?: string): Headers {
  const headers = new Headers({
    "content-type": artifact.content_type,
    "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(artifact.filename)}`,
    "accept-ranges": "bytes",
    "cache-control": "private, no-store",
    "content-length": String(artifact.size_bytes),
  });
  if (etag) headers.set("etag", etag);
  if (artifact.sha256) headers.set("x-artifact-sha256", artifact.sha256);
  return headers;
}
