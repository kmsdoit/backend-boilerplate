import { describe, expect, it } from "vitest";

import { checkReadiness } from "./health.ts";

/**
 * No database needed: the point of the injection seam in checkReadiness is
 * that a hung connection and an unreachable one can both be proven without a
 * socket, and without waiting out a real timeout.
 */
const fakeEm = (execute: () => Promise<unknown>) =>
  ({ getConnection: () => ({ execute }) }) as never;

describe("checkReadiness", () => {
  it("reports ok when the database answers", async () => {
    const result = await checkReadiness({
      getEntityManager: async () => fakeEm(async () => [{ "?column?": 1 }]),
    });

    expect(result).toEqual({ ok: true, checks: [{ name: "database", ok: true }] });
  });

  it("reports the failure message when the database is unreachable", async () => {
    const result = await checkReadiness({
      getEntityManager: async () => {
        throw new Error("ECONNREFUSED");
      },
    });

    expect(result.ok).toBe(false);
    expect(result.checks[0]).toMatchObject({ name: "database", ok: false, error: "ECONNREFUSED" });
  });

  // The case the timeout exists for: acquiring a connection hangs, so there is
  // never a query to time out. A timeout around execute() alone would wait
  // forever here and the probe would never answer.
  it("gives up on a hung connection instead of waiting forever", async () => {
    const result = await checkReadiness({
      getEntityManager: () => new Promise(() => {}),
      timeoutMs: 20,
    });

    expect(result.ok).toBe(false);
    expect(result.checks[0]?.error).toMatch(/timed out after 20ms/);
  });
});
