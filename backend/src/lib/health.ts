import { tableExists } from "@app/database";

/**
 * Readiness budget. Must stay comfortably under the orchestrator's own probe
 * timeout, or the probe is marked failed before this code answers for itself
 * and the failure reason you get is useless.
 */
const READINESS_TIMEOUT_MS = 2000;

export type ReadinessCheck = { name: string; ok: boolean; error?: string };
export type ReadinessResult = { ok: boolean; checks: ReadinessCheck[] };

/** Injected for tests: a fake that never resolves proves the timeout fires without a socket. */
type ReadinessOverrides = {
  checkTable?: () => Promise<boolean>;
  timeoutMs?: number;
};

/**
 * Bounds how long we *wait*, not how long the request runs. That is the right
 * trade for a probe: the goal is "never make the orchestrator wait longer than
 * our budget", not "cancel the call".
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} check timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * DescribeTable, not a read of real data: it confirms credentials resolve, the
 * endpoint is reachable and the table is ACTIVE, without depending on any item
 * existing. A probe that queries actual rows fails for reasons that have
 * nothing to do with this instance's health.
 */
async function checkTable(overrides: ReadinessOverrides = {}): Promise<ReadinessCheck> {
  const probe = overrides.checkTable ?? tableExists;
  const timeoutMs = overrides.timeoutMs ?? READINESS_TIMEOUT_MS;

  try {
    const ok = await withTimeout(probe(), timeoutMs, "dynamo");
    return ok
      ? { name: "dynamo", ok: true }
      : { name: "dynamo", ok: false, error: "table is missing or not ACTIVE" };
  } catch (err) {
    return { name: "dynamo", ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Backs GET /ready. Add a dependency here only when a request genuinely cannot
 * be served without it: every check is a way for a healthy instance to be
 * pulled out of rotation.
 */
export async function checkReadiness(overrides: ReadinessOverrides = {}): Promise<ReadinessResult> {
  const checks = await Promise.all([checkTable(overrides)]);
  return { ok: checks.every((check) => check.ok), checks };
}
