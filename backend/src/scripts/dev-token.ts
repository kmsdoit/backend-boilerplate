#!/usr/bin/env bun
/**
 * Prints a signed JWT for poking at the API locally:
 *
 *   bun run --cwd backend dev:token                  # admin, id 1
 *   bun run --cwd backend dev:token 42 member        # member, id 42
 *   curl -H "Authorization: Bearer $(bun run --cwd backend dev:token)" \
 *        localhost:3000/users
 *
 * Refuses to run in production. A one-command token minter that works against
 * the production signing key is an authentication bypass with a friendly CLI.
 */
import { sign } from "hono/jwt";

import { applicationConfig } from "@app/config";

import { env } from "../lib/env.ts";

if (env.NODE_ENV === "production") {
  throw new Error("dev:token refuses to mint tokens against a production signing key.");
}

const subject = process.argv[2] ?? "1";
const role = process.argv[3] ?? "admin";
const expiresInSeconds = 60 * 60 * 24;

const token = await sign(
  {
    sub: subject,
    role,
    exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
    ...(applicationConfig.auth.issuer ? { iss: applicationConfig.auth.issuer } : {}),
    ...(applicationConfig.auth.audience ? { aud: applicationConfig.auth.audience } : {}),
  },
  env.JWT_SECRET,
  "HS256",
);

// Bare token on stdout, so it composes with $(...) in a shell.
console.log(token);
