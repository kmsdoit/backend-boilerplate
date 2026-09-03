import { describe, expect, it } from "vitest";
import { z } from "zod";

import { MAX_PAGE_SIZE, paginationQueryShape, toOffset } from "./pagination.ts";

const paginationSchema = z.object(paginationQueryShape);

describe("paginationQueryShape", () => {
  it("coerces query strings and applies defaults", () => {
    expect(paginationSchema.parse({})).toEqual({ page: 1, pageSize: 20 });
    expect(paginationSchema.parse({ page: "3", pageSize: "50" })).toEqual({
      page: 3,
      pageSize: 50,
    });
  });

  it("caps pageSize so a caller cannot request the whole table", () => {
    expect(paginationSchema.safeParse({ pageSize: String(MAX_PAGE_SIZE + 1) }).success).toBe(false);
  });

  it("computes a 1-based offset", () => {
    expect(toOffset({ page: 1, pageSize: 20 })).toBe(0);
    expect(toOffset({ page: 3, pageSize: 20 })).toBe(40);
  });
});
