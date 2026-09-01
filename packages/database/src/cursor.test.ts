import { describe, expect, it } from "vitest";

import { decodeCursor, encodeCursor } from "./cursor.ts";

describe("cursor", () => {
  it("round-trips a LastEvaluatedKey", () => {
    const key = { pk: "USER#1", gsi1pk: "USER", gsi1sk: "2026-01-01#1" };
    expect(decodeCursor(encodeCursor(key))).toEqual(key);
  });

  it("is url-safe so it survives a query string", () => {
    const encoded = encodeCursor({ pk: "USER#" + "?&=/+".repeat(4) });
    expect(encoded).toBeDefined();
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("has no cursor when there is no next page", () => {
    expect(encodeCursor(undefined)).toBeUndefined();
  });

  /**
   * A cursor is caller-supplied and will eventually arrive truncated by a URL
   * shortener or hand-edited. Treating a bad one as "start from the beginning"
   * keeps a stale bookmark from becoming a 500.
   */
  it.each(["not-base64!!", "", "bnVsbA", "W10"])("ignores the unusable cursor %s", (bad) => {
    expect(decodeCursor(bad)).toBeUndefined();
  });
});
