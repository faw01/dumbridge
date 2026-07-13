import { describe, expect, test } from "bun:test";
import { assessPackManifest } from "../scripts/verify-pack";

const manifest = (paths: readonly string[]) => ({
  entryCount: paths.length,
  files: paths.map((path) => ({ path })),
});

const cleanPaths = ["LICENSE", "README.md", "dist/cli.js", "package.json"];

describe("package manifest", () => {
  test("accepts the publish allowlist", () => {
    expect(assessPackManifest(manifest(cleanPaths))).toEqual([]);
  });

  test("rejects source and secrets", () => {
    const problems = assessPackManifest(
      manifest([...cleanPaths, "src/cli.ts", ".env.local"])
    );

    expect(problems).toContain("forbidden package entry: src/cli.ts");
    expect(problems).toContain("forbidden package entry: .env.local");
  });

  test("requires the executable", () => {
    const problems = assessPackManifest(
      manifest(cleanPaths.filter((path) => path !== "dist/cli.js"))
    );

    expect(problems).toContain("missing expected file: dist/cli.js");
  });
});
