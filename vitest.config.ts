import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    /**
     * Exclude integration tests from the default unit-only run.
     * Two complementary rules for defence-in-depth:
     *   1. Dir-based:    src/integration/** — catches everything in the dir.
     *   2. Suffix-based: **\/*.integration.test.ts — catches any stray file
     *                    placed outside the integration/ directory.
     * Extends vitest's built-in defaults (which include node_modules, dist, etc.).
     */
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/cypress/**",
      "**/.{idea,git,cache,output,temp}/**",
      "**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*",
      "src/integration/**",
      "**/*.integration.test.ts",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/test-harness.ts"],
    },
  },
});
