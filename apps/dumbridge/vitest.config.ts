import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The CLI and tarball suites spawn real Bun processes and stay on
    // bun test; the package test script runs both runners.
    include: ["test/bridge/**/*.test.ts"],
  },
});
