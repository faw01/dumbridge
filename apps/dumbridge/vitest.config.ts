import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The real iroh transport and the live-clock supervision tests compete
    // for CPU on small CI runners; run files sequentially like bun test did.
    fileParallelism: false,
    // The CLI and tarball suites spawn real Bun processes and stay on
    // bun test; the package test script runs both runners.
    include: ["test/bridge/**/*.test.ts"],
  },
});
