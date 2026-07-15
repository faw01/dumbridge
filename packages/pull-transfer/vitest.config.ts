import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // atomic-publish exercises the bun:ffi publisher directly and stays on
    // bun test; the package test script runs both runners.
    exclude: ["test/atomic-publish.test.ts"],
    include: ["test/**/*.test.ts"],
  },
});
