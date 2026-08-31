import { getEntityManager as getSharedEntityManager } from "./db.ts";

/**
 * Readiness budget. Must stay comfortably under the orchestrator's own probe
 * timeout (Kubernetes `readinessProbe.timeoutSeconds`, an ALB health check
 * interval, ...), or the probe is marked failed before this code gets to
 * answer for itself and the failure reason you get is useless.
 */
const READINESS_TIMEOUT_MS = 2000;

export type ReadinessCheck = {
  name: string;
  ok: boolean;
  error?: string;
};

export type ReadinessResult = {
  ok: boolean;
  checks: ReadinessCheck[];
};

type EntityManagerLike = Awaited<ReturnType<typeof getSharedEntityManager>>;

/**
 * Injected for tests: a fake that never resolves proves the timeout actually
 * fires without touching a socket, and one that rejects immediately proves
 * the "unreachable" path without waiting out the timeout. Defaults to the
 * real connection.
 */
type ReadinessOverrides = {
  getEntityManager?: () => Promise<EntityManagerLike>;
  timeoutMs?: number;
};

/**
 * Races a promise against a timer.
 *
 * This bounds how long we *wait*, not how long the query runs -- the
 * underlying query keeps going until it finishes or the socket resets. That
 * is the right trade for a probe: the goal is "never make the orchestrator
 * wait longer than our budget", not "cancel the query".
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} check timed out after ${ms}ms`));
    }, ms);

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

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * PostgreSQL is reachable and answering.
 *
 * The timeout wraps EntityManager acquisition, not just the query. A
 * partitioned database, an overloaded host, or an exhausted connection pool
 * hangs during connect/acquire -- before there is any query to time out. A
 * timeout around `execute()` alone leaves that path completely unbounded,
 * which is exactly the case a readiness probe exists to catch.
 */
async function checkDatabase(overrides: ReadinessOverrides = {}): Promise<ReadinessCheck> {
  const getEntityManager = overrides.getEntityManager ?? getSharedEntityManager;
  const timeoutMs = overrides.timeoutMs ?? READINESS_TIMEOUT_MS;

  try {
    await withTimeout(
      (async () => {
        const em = await getEntityManager();
        return em.getConnection().execute("SELECT 1");
      })(),
      timeoutMs,
      "database",
    );
    return { name: "database", ok: true };
  } catch (err) {
    return { name: "database", ok: false, error: toErrorMessage(err) };
  }
}

/**
 * Backs GET /ready. Checks run in parallel and each catches its own errors,
 * so one failing dependency cannot throw and skip reporting on the others.
 * Because each is individually bounded, the wall-clock ceiling for the whole
 * set is `timeoutMs` -- an outer race would only duplicate that bound.
 *
 * Add a dependency here when a request genuinely cannot be served without it.
 * Do NOT add one the service merely talks to occasionally: every check here
 * is a way for a healthy pod to be pulled out of rotation.
 */
export async function checkReadiness(overrides: ReadinessOverrides = {}): Promise<ReadinessResult> {
  const checks = await Promise.all([checkDatabase(overrides)]);
  return { ok: checks.every((check) => check.ok), checks };
}
