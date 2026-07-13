import { describe, expect, test } from "bun:test";
import { assessPackManifest } from "../scripts/verify-pack";

const manifest = (paths: readonly string[]) => ({
  files: paths.map((path) => ({ path })),
});

const cleanPaths = ["LICENSE", "README.md", "dist/cli.js", "package.json"];

describe("package manifest", () => {
  test("accepts the publish allowlist", () => {
    expect(assessPackManifest(manifest(cleanPaths))).toEqual([]);
  });

  test("rejects every file outside the allowlist", () => {
    const problems = assessPackManifest(
      manifest([...cleanPaths, "docs/example.md", "src/cli.ts", ".env.local"])
    );

    expect(problems).toEqual([
      "unexpected package entry: docs/example.md",
      "unexpected package entry: src/cli.ts",
      "unexpected package entry: .env.local",
    ]);
  });

  test("requires the executable", () => {
    const problems = assessPackManifest(
      manifest(cleanPaths.filter((path) => path !== "dist/cli.js"))
    );

    expect(problems).toContain("missing expected file: dist/cli.js");
  });
});
