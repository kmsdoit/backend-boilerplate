import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The logger reads `applicationConfig.application.environment` once, at
 * import time, to decide between the JSON branch and the human-readable
 * "development" branch (see the comment in logger.ts for why it isn't
 * `process.env.NODE_ENV`). To exercise both branches here without actually
 * pointing APP_CONFIG_PATH at a development config file, each test
 * mocks `@app/config` before dynamically importing a fresh copy of
 * logger.ts -- `vi.resetModules()` in afterEach guarantees the next test's
 * `import("./logger.ts")` re-evaluates against its own mock instead of a
 * cached module.
 *
 * Console methods must be spied on BEFORE importing logger.ts, not after:
 * the module captures `console.log`/`warn`/`error` by reference into its
 * `consoleFor` map at import time, so a spy installed after import replaces
 * `console.log` globally but the already-imported module keeps calling the
 * pre-spy function it captured.
 */

function mockEnvironment(environment: "development" | "production" | "test"): void {
  vi.doMock("@app/config", () => ({
    applicationConfig: { application: { name: "test-service", environment } },
  }));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock("@app/config");
  vi.resetModules();
});

describe("logger (non-development)", () => {
  it("emits one JSON line merging time, level, message and fields", async () => {
    mockEnvironment("production");
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { logger } = await import("./logger.ts");

    logger.info("hello", { a: 1 });

    expect(spy).toHaveBeenCalledTimes(1);
    const parsed: unknown = JSON.parse(spy.mock.calls[0]?.[0] as string);
    expect(parsed).toMatchObject({
      level: "info",
      message: "hello",
      service: "test-service",
      a: 1,
    });
    expect(typeof (parsed as { time: unknown }).time).toBe("string");
  });

  it("defaults fields to {} when omitted", async () => {
    mockEnvironment("test");
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { logger } = await import("./logger.ts");

    logger.warn("careful");

    const parsed: unknown = JSON.parse(spy.mock.calls[0]?.[0] as string);
    expect(parsed).toMatchObject({ level: "warn", message: "careful" });
  });

  it("dispatches info/warn/error to the matching console method", async () => {
    mockEnvironment("production");
    const infoSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { logger } = await import("./logger.ts");

    logger.info("i");
    logger.warn("w");
    logger.error("e");

    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("log() dispatches by its explicit level argument", async () => {
    mockEnvironment("production");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { logger } = await import("./logger.ts");

    logger.log("error", "bad thing", { code: 500 });

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const parsed: unknown = JSON.parse(errorSpy.mock.calls[0]?.[0] as string);
    expect(parsed).toMatchObject({ level: "error", message: "bad thing", code: 500 });
  });
});

describe("logger (development)", () => {
  it("renders a human-readable line with fields appended as a JSON blob", async () => {
    mockEnvironment("development");
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { logger } = await import("./logger.ts");

    logger.info("hello", { a: 1 });

    const line = spy.mock.calls[0]?.[0] as string;
    expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[INFO] hello \{"a":1}$/);
  });

  it("omits the trailing JSON blob when there are no fields", async () => {
    mockEnvironment("development");
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { logger } = await import("./logger.ts");

    logger.info("hello");

    const line = spy.mock.calls[0]?.[0] as string;
    expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[INFO] hello$/);
  });
});
