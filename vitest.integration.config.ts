import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts"],
    /** Integration tests call real network; give them more time. */
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
