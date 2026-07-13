import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { BunServices } from "@effect/platform-bun";
import { Effect, Option } from "effect";
import { Command } from "effect/unstable/cli";
import { pull } from "../src/cli";

const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

const invoke = async (...args: readonly string[]) => {
  const process = Bun.spawn(["bun", "run", cliPath, ...args], {
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);

  return { exitCode, stderr, stdout };
};

describe("dumbridge CLI", () => {
  test("shows help", async () => {
    const result = await invoke("--help");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("dumbridge");
    expect(result.stdout).toContain("--help");
  });

  test("shows its package version", async () => {
    const result = await invoke("--version");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe("dumbridge v0.0.0");
  });

  test("advertises only the v1 commands", async () => {
    const [root, serve, run, pullHelp] = await Promise.all([
      invoke("--help"),
      invoke("serve", "--help"),
      invoke("run", "--help"),
      invoke("pull", "--help"),
    ]);

    expect(root.stdout).toContain("serve");
    expect(root.stdout).toContain("run");
    expect(root.stdout).toContain("pull");
    expect(serve.stdout).toContain("dumbridge serve [flags] <root>");
    expect(run.stdout).toContain("dumbridge run [flags] <script>");
    expect(pullHelp.stdout).toContain(
      "dumbridge pull [flags] <path> [<destination>]"
    );
  });

  test("maps pull path before its optional destination", async () => {
    let parsed: unknown;
    const command = pull.pipe(
      Command.withHandler((value) =>
        Effect.sync(() => {
          parsed = value;
        })
      )
    );

    await Effect.runPromise(
      Command.runWith(command, { version: "test" })([
        "remote/file",
        "local/file",
      ]).pipe(Effect.provide(BunServices.layer))
    );

    expect(parsed).toEqual({
      destination: Option.some("local/file"),
      path: "remote/file",
    });
  });
});
