import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import packageJson from "../package.json" with { type: "json" };
import { encodeBridgeLink, mintCapability } from "../src/bridge/link";
import { publicErrorMessage, resolveClientTransportOptions } from "../src/cli";

const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

const invokeWithEnvironment = async (
  environment: Readonly<Record<string, string>>,
  ...args: readonly string[]
) => {
  const process = Bun.spawn(["bun", "run", cliPath, ...args], {
    env: { ...globalThis.process.env, ...environment },
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

const invoke = (...args: readonly string[]) =>
  invokeWithEnvironment({}, ...args);

describe("dumbridge CLI", () => {
  test("shows help when no command is provided", async () => {
    const result = await invoke();

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("dumbridge <subcommand> [flags]");
  });

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
    expect(result.stdout.trim()).toBe(`dumbridge v${packageJson.version}`);
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
    expect(root.stdout).toContain("skill");
    expect(serve.stdout).toContain("dumbridge serve [flags] <root>");
    expect(run.stdout).toContain("dumbridge run [flags] <script>");
    expect(pullHelp.stdout).toContain(
      "dumbridge pull [flags] <remote-path> [<destination>]"
    );
    expect(root.stdout).toContain("serve locally");
    expect(root.stdout).toContain("DUMBRIDGE_LINK");
    expect(serve.stdout).toContain("DUMBRIDGE_LINK");
    expect(run.stdout).toContain("DUMBRIDGE_LINK");
    expect(pullHelp.stdout).toContain("DUMBRIDGE_LINK");
  });

  test("prints the bundled agent skill guide", async () => {
    const skillPath = fileURLToPath(
      new URL("../../../skills/dumbridge/SKILL.md", import.meta.url)
    );
    const guide = await Bun.file(skillPath).text();
    const result = await invoke("skill");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(guide);
  });

  test("reports a missing bridge link without an Effect cause dump", async () => {
    const result = await invoke("run", "true");

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("dumbridge: DUMBRIDGE_LINK is not set.\n");
  });

  test("reports an invalid pull path before attempting a connection", async () => {
    const link = Effect.runSync(
      Effect.fromResult(
        encodeBridgeLink({
          capability: mintCapability(),
          locator: "unused-client",
          transport: "iroh",
        })
      )
    );
    const result = await invokeWithEnvironment(
      { DUMBRIDGE_LINK: link },
      "pull",
      "../secret"
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("dumbridge: The pull path is invalid.\n");
  });

  test("uses relay-only reachability whenever a cloud proxy is selected", () => {
    expect(
      resolveClientTransportOptions({ HTTPS_PROXY: "http://proxy" })
    ).toEqual({
      proxy: { _tag: "FromEnvironment" },
      reachability: "relay-only",
    });
    expect(resolveClientTransportOptions({})).toEqual({
      proxy: { _tag: "Disabled" },
    });
  });

  test("maps pull IO failures and empty errors to stable public text", () => {
    expect(
      publicErrorMessage({
        _tag: "PullIOError",
        message: "/private/host/path",
      })
    ).toBe("The pull could not be completed.");
    expect(
      publicErrorMessage({
        _tag: "PullRemoteLimitError",
        path: "large.bin",
      })
    ).toBe("The remote pull exceeded a safety limit.");
    expect(publicErrorMessage({ message: "   " })).toBe("dumbridge failed.");
  });
});
