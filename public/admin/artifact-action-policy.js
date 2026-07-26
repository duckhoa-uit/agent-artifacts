const INLINE_CONTENT_TYPES = new Set([
  "text/plain",
  "application/json",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "audio/mpeg",
  "audio/mp4",
  "audio/ogg",
  "audio/wav",
]);

export const BREAK_GLASS_BUFFER_LIMIT_BYTES = 25 * 1024 * 1024;

export function artifactActionPolicy({ sessionMode, contentType, sizeBytes }) {
  const inline = canPreviewInline(contentType);
  if (sessionMode === "cloudflare-access") {
    return { delivery: inline ? "navigate" : "download", inline };
  }
  if (sessionMode !== "break-glass") {
    return { delivery: "blocked", inline, message: "Reconnect the admin session before opening an artifact." };
  }
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    return { delivery: "blocked", inline, message: "Artifact size is unavailable; reconnect with Cloudflare Access to stream it." };
  }
  if (sizeBytes > BREAK_GLASS_BUFFER_LIMIT_BYTES) {
    return { delivery: "blocked", inline, message: "Break-glass artifact actions are limited to 25 MiB. Use Cloudflare Access to stream larger artifacts." };
  }
  return { delivery: "bounded-buffer", inline };
}

export function canPreviewInline(contentType) {
  return INLINE_CONTENT_TYPES.has(contentType.split(";", 1)[0].trim().toLowerCase());
}
