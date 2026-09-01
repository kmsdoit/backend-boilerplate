import { describe, expect, it } from "vitest";
import { z } from "zod";

import { MAX_PAGE_SIZE, paginationQueryShape } from "./pagination.ts";

const paginationSchema = z.object(paginationQueryShape);

describe("paginationQueryShape", () => {
  it("coerces query strings and applies defaults", () => {
    expect(paginationSchema.parse({})).toEqual({ limit: 20 });
    expect(paginationSchema.parse({ limit: "50" })).toEqual({ limit: 50 });
  });

  it("caps limit so a caller cannot request the whole table", () => {
    expect(paginationSchema.safeParse({ limit: String(MAX_PAGE_SIZE + 1) }).success).toBe(false);
  });

  it("carries an opaque cursor through untouched", () => {
    const cursor = "eyJwayI6IlVTRVIjMSJ9";
    expect(paginationSchema.parse({ cursor })).toEqual({ limit: 20, cursor });
  });
});
