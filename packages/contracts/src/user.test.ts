import { describe, expect, it } from "vitest";

import { createUserSchema, updateUserSchema } from "./user.ts";

describe("createUserSchema", () => {
  it("defaults role to member", () => {
    expect(createUserSchema.parse({ email: "a@example.com", name: "A" }).role).toBe("member");
  });

  it("rejects an unknown key rather than dropping it", () => {
    const result = createUserSchema.safeParse({
      email: "a@example.com",
      name: "A",
      isAdmin: true,
    });
    expect(result.success).toBe(false);
  });
});

describe("updateUserSchema", () => {
  it("rejects an empty body", () => {
    expect(updateUserSchema.safeParse({}).success).toBe(false);
  });

  it("accepts a single field", () => {
    expect(updateUserSchema.safeParse({ status: "suspended" }).success).toBe(true);
  });

  // A typo'd field must fail loudly; silently ignoring it makes a PATCH that
  // changed nothing look like it succeeded.
  it("rejects a misspelled field", () => {
    expect(updateUserSchema.safeParse({ nmae: "typo" }).success).toBe(false);
  });
});
