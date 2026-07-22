import { describe, expect, it } from "vitest";
import { constantTimeEqual, parseRange, safeFilename } from "../src/utils";

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

  it("sanitizes filenames and compares secrets without early exit", () => {
    expect(safeFilename("../video\n.mp4")).toBe(".._video_.mp4");
    expect(constantTimeEqual("same", "same")).toBe(true);
    expect(constantTimeEqual("same", "different")).toBe(false);
  });
});
