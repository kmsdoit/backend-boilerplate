import { applicationConfig } from "@app/config";

/**
 * The narrow slice of configuration this service reads, named the way the
 * code talks about it.
 *
 * Everything still originates in config/application.yml -- this is a
 * projection of `applicationConfig`, not a second source of truth. The value
 * of the indirection is that grepping for `process.env` in this codebase
 * returns nothing, so there is no third place a setting could be coming from.
 */
export type Env = {
  NODE_ENV: "development" | "production" | "test";
  SERVICE_NAME: string;
  PORT: number;
  JWT_SECRET: string;
};

export const env: Env = {
  NODE_ENV: applicationConfig.application.environment,
  SERVICE_NAME: applicationConfig.application.name,
  PORT: applicationConfig.server.port,
  JWT_SECRET: applicationConfig.auth.jwtSecret,
};
