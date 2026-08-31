import { applicationConfig } from "@app/config";
import {
  closeORM as closeSharedORM,
  getEntityManager as getSharedEntityManager,
  initializeORM as initializeSharedORM,
} from "@app/database";

/**
 * The one place the real database URL is read. Everything downstream takes an
 * EntityManager as an argument, which is what makes the repositories testable
 * against a throwaway database.
 */
const databaseOptions = {
  databaseUrl: applicationConfig.database.url,
  pool: applicationConfig.database.pool,
  // Deliberately above server.requestTimeoutMs: the HTTP timeout should be
  // what a caller normally sees, and this is the backstop that stops the
  // query itself when the HTTP layer has already given up.
  statementTimeoutMs: applicationConfig.server.requestTimeoutMs + 5_000,
};

export function initializeORM() {
  return initializeSharedORM(databaseOptions);
}

/** A forked, request-safe EntityManager. Call once per request. */
export function getEntityManager() {
  return getSharedEntityManager(databaseOptions);
}

export function closeORM(): Promise<void> {
  return closeSharedORM();
}
