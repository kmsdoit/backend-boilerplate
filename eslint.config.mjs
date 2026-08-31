// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

// Built to one rule: start from a rule set the current code already passes,
// not from a preset that lights up red on day one. Anything deliberately left
// off carries a comment saying what would need to happen before turning it on.
export default tseslint.config(
  {
    // Left at ESLint's default ("warn"), a dead `eslint-disable` comment --
    // one naming a rule that isn't on, or that no longer fires -- passes
    // `bun run lint` silently. Promoted so CI actually fails on it, which is
    // the only thing that keeps disable comments meaningful.
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
  },

  {
    // Generated/vendored output. Migrations are MikroORM-CLI-generated files
    // full of raw SQL strings -- linting them produces diffs with no human
    // decision behind them.
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/coverage/**",
      "packages/database/migrations/**",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        crypto: "readonly",
        performance: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        URL: "readonly",
        fetch: "readonly",
        Request: "readonly",
        Response: "readonly",
        AbortController: "readonly",
        __dirname: "readonly",
      },
    },
    rules: {
      // Already enforced at the type-checker level: every package's tsconfig
      // extends tsconfig.base.json, which sets noUnusedLocals /
      // noUnusedParameters. Running it here too is a second implementation of
      // the same check that can drift from the first.
      "@typescript-eslint/no-unused-vars": "off",
    },
  },

  // --- Type-aware linting ---
  //
  // Scoped to package source trees, each of which has its own tsconfig.json
  // that `projectService` can walk up to. Root-level TS files
  // (vitest.workspace.ts) are deliberately excluded: they are not inside any
  // package's tsconfig "include", so projectService has no project to resolve
  // them against and would hard-fail parsing rather than skip the rules.
  //
  // Only the two rules the codebase actually needs are on. The full
  // `recommendedTypeChecked` preset (~60 rules) stays off until someone
  // evaluates it one rule at a time.
  {
    files: [
      "backend/src/**/*.ts",
      "packages/config/src/**/*.ts",
      "packages/contracts/src/**/*.ts",
      "packages/database/src/**/*.ts",
      "packages/observability/src/**/*.ts",
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Both are named by eslint-disable comments in
      // backend/src/lib/hono-adapter.ts, where RouteDef types its fields
      // loosely on purpose so one registration function can host route defs
      // whose param/body/response types all differ. Turning the rules on is
      // what makes those comments mean something.
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/unbound-method": "error",
    },
  },

  // Test files legitimately need `any` casts to build fakes that production
  // code should never need. Loosened here instead of scattering more
  // eslint-disable comments through the suite.
  {
    files: ["**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
    },
  },

  // Must be last: turns off stylistic rules that would fight Prettier.
  eslintConfigPrettier,
);
