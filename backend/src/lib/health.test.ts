import { describe, expect, it } from "vitest";

import { checkReadiness } from "./health.ts";

/**
 * No database needed: the injection seam exists so that an unreachable table
 * and a hung call can both be proven without a socket, and without waiting out
 * a real timeout.
 */
describe("checkReadiness", () => {
  it("reports ok when the table is ACTIVE", async () => {
    const result = await checkReadiness({ checkTable: async () => true });
    expect(result).toEqual({ ok: true, checks: [{ name: "dynamo", ok: true }] });
  });

  it("reports not-ok when the table is missing", async () => {
    const result = await checkReadiness({ checkTable: async () => false });
    expect(result.ok).toBe(false);
    expect(result.checks[0]?.error).toMatch(/missing or not ACTIVE/);
  });

  it("reports the failure message when the endpoint is unreachable", async () => {
    const result = await checkReadiness({
      checkTable: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(result.ok).toBe(false);
    expect(result.checks[0]).toMatchObject({ name: "dynamo", ok: false, error: "ECONNREFUSED" });
  });

  // The case the timeout exists for: the call hangs, so there is never a
  // response to time out on.
  it("gives up on a hung call instead of waiting forever", async () => {
    const result = await checkReadiness({
      checkTable: () => new Promise(() => {}),
      timeoutMs: 20,
    });
    expect(result.ok).toBe(false);
    expect(result.checks[0]?.error).toMatch(/timed out after 20ms/);
  });
});
