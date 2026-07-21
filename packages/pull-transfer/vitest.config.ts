import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["test/atomic-publish.test.ts"],
    include: ["test/**/*.test.ts"],
  },
});
