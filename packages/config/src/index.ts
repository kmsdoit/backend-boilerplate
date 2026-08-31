/**
 * Node entry point for `@app/config`: everything in core.ts, plus loading the
 * YAML from disk. This is what a container or a Lambda gets.
 *
 * Edge runtimes resolve `./edge.ts` instead, via the `workerd` condition in
 * this package's exports map -- see the comment in core.ts for why the
 * filesystem read has to be isolated to this file.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadApplicationConfigFromYaml, type ApplicationConfig } from "./core.ts";

export * from "./core.ts";

/**
 * Exported so tests (and anything else addressing a file under `config/`
 * relative to this package rather than to process.cwd()) can resolve paths
 * the same way the default below does.
 */
export const packageDirectory = dirname(fileURLToPath(import.meta.url));
const defaultApplicationConfigPath = resolve(packageDirectory, "../../../config/application.yml");
const applicationConfigPath = process.env.APP_CONFIG_PATH
  ? resolve(process.env.APP_CONFIG_PATH)
  : defaultApplicationConfigPath;

/**
 * Reads, resolves `${ENV}` placeholders in, and schema-validates the config
 * at an arbitrary path.
 *
 * Exported (alongside `applicationConfigSchema`) so a test can load
 * config/application.sample.yml and catch schema/sample drift -- a required
 * field added to the schema but never added to the sample -- without spawning
 * a second process. `applicationConfig` below is unaffected and still
 * resolves exactly once, at import time.
 */
export function loadApplicationConfigFromPath(configPath: string): ApplicationConfig {
  const resolvedPath = resolve(configPath);
  let source: string;

  try {
    source = readFileSync(resolvedPath, "utf8");
  } catch (error) {
    throw new Error(
      `Unable to read application config at ${resolvedPath}. Copy config/application.sample.yml to config/application.yml.`,
      { cause: error },
    );
  }

  return loadApplicationConfigFromYaml(source, resolvedPath);
}

/**
 * Built once, at module load. Importing this module is what validates the
 * config, so a misconfigured process dies at startup rather than on the first
 * request that happens to read a bad value.
 *
 * `APP_CONFIG` (the YAML document itself) wins over `APP_CONFIG_PATH` (a path
 * to it). Two reasons it exists on the Node entry and not only on the edge one:
 * a Lambda can carry its config in an environment variable with no file to
 * package, and -- more subtly -- the default path is resolved relative to THIS
 * FILE, which stops being meaningful the moment the code is bundled, since
 * `import.meta.url` then points into dist/. Anything bundled must set one of
 * the two variables. `${ENV}` substitution applies either way, so secrets stay
 * in their own variables rather than being inlined into one blob.
 */
export const applicationConfig: ApplicationConfig = process.env.APP_CONFIG
  ? loadApplicationConfigFromYaml(process.env.APP_CONFIG, "APP_CONFIG")
  : loadApplicationConfigFromPath(applicationConfigPath);

export { applicationConfigPath };
