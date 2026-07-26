import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  artifactActionPolicy,
  BREAK_GLASS_BUFFER_LIMIT_BYTES,
} from "../public/admin/artifact-action-policy.js";

describe("admin artifact action policy", () => {
  it("streams safe media through same-origin navigation for Access sessions", () => {
    expect(artifactActionPolicy({
      sessionMode: "cloudflare-access",
      contentType: "video/mp4",
      sizeBytes: BREAK_GLASS_BUFFER_LIMIT_BYTES * 10,
    })).toEqual({ delivery: "navigate", inline: true });
  });

  it.each(["text/html", "image/svg+xml", "application/pdf"])(
    "leaves unsafe %s content on the server-enforced download path",
    (contentType) => {
      expect(artifactActionPolicy({
        sessionMode: "cloudflare-access",
        contentType,
        sizeBytes: BREAK_GLASS_BUFFER_LIMIT_BYTES * 10,
      })).toEqual({ delivery: "download", inline: false });
    },
  );

  it("allows only bounded buffering for break-glass sessions", () => {
    expect(artifactActionPolicy({
      sessionMode: "break-glass",
      contentType: "video/mp4",
      sizeBytes: BREAK_GLASS_BUFFER_LIMIT_BYTES,
    })).toEqual({ delivery: "bounded-buffer", inline: true });

    expect(artifactActionPolicy({
      sessionMode: "break-glass",
      contentType: "video/mp4",
      sizeBytes: BREAK_GLASS_BUFFER_LIMIT_BYTES + 1,
    })).toMatchObject({ delivery: "blocked", inline: true });
  });

  it("does not use the unbounded Response.blob API", async () => {
    const source = await readFile(resolve(import.meta.dirname, "../public/admin/app.js"), "utf8");
    expect(source).not.toContain("response.blob()");
    expect(source).toContain("response.body.getReader()");
    expect(source).toContain('fetch(contentUrl, { headers:{ authorization:`Bearer ${state.token}` } })');
    expect(source).not.toMatch(/contentUrl\s*=\s*`[^`]*state\.token/);
  });
});
