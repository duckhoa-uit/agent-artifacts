import { describe, expect, it } from "vitest";
import { artifactHeaders, canPreviewInline, etagMatches, parseRange, safeFilename } from "../src/utils";

describe("artifact utilities", () => {
  it("parses normal and suffix ranges", () => {
    expect(parseRange("bytes=2-5", 10)).toEqual({ offset: 2, length: 4 });
    expect(parseRange("bytes=-3", 10)).toEqual({ offset: 7, length: 3 });
    expect(parseRange("bytes=8-", 10)).toEqual({ offset: 8, length: 2 });
  });

  it("rejects unsatisfiable ranges", () => {
    expect(parseRange("bytes=10-12", 10)).toBeNull();
    expect(parseRange("items=0-1", 10)).toBeNull();
  });

  it("matches entity-tag lists and weak validators", () => {
    expect(etagMatches(`"old", W/"current"`, `"current"`, true)).toBe(true);
    expect(etagMatches("*", `"current"`, false)).toBe(true);
    expect(etagMatches(`W/"current"`, `"current"`, false)).toBe(false);
  });

  it("sanitizes filenames", () => {
    expect(safeFilename("../video\n.mp4")).toBe(".._video_.mp4");
  });

  it("only renders inert media types inline", () => {
    expect(canPreviewInline("image/png")).toBe(true);
    expect(canPreviewInline("text/plain; charset=utf-8")).toBe(true);
    expect(canPreviewInline("text/html")).toBe(false);
    expect(canPreviewInline("image/svg+xml")).toBe(false);
    expect(canPreviewInline("application/javascript")).toBe(false);

    const headers = artifactHeaders({ filename: "payload.html", content_type: "text/html", size_bytes: 12 });
    expect(headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(headers.get("content-security-policy")).toContain("sandbox");
    expect(headers.get("content-security-policy")).toContain("default-src 'none'");
  });
});
