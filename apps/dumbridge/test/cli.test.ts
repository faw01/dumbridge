import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeBridgeKey, mintCapability } from "@dumbridge/bridge-key";
import { PullLimitError } from "@dumbridge/pull-transfer";
import { Effect } from "effect";
import packageJson from "../package.json" with { type: "json" };
import {
  connectionPathNotice,
  proxyFallbackNotice,
  publicErrorMessage,
  resolveClientTransportOptions,
} from "../src/cli";

const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

const invokeCli = async (options: {
  readonly args: readonly string[];
  readonly environment?: Readonly<Record<string, string>>;
  readonly stdin?: string;
}) => {
  const process = Bun.spawn(["bun", "run", cliPath, ...options.args], {
    env: { ...globalThis.process.env, ...options.environment },
    stderr: "pipe",
    stdin:
      options.stdin === undefined
        ? "ignore"
        : new TextEncoder().encode(options.stdin),
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);

  return { exitCode, stderr, stdout };
};

const invokeWithEnvironment = (
  environment: Readonly<Record<string, string>>,
  ...args: readonly string[]
) => invokeCli({ args, environment });

const invoke = (...args: readonly string[]) => invokeCli({ args });

const mintKeyExpiringAt = (expiresAt: number) =>
  Effect.runSync(
    Effect.fromResult(
      encodeBridgeKey({
        capability: mintCapability(),
        expiresAt,
        locator: "unused-client",
        transport: "iroh",
      })
    )
  );

const expiredKeyMessage = (expiresAt: number) =>
  `dumbridge: The bridge key expired at ${new Date(expiresAt).toISOString()}. Run dumbridge serve again to mint a fresh key.\n`;

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
    expect(serve.stdout).toContain("dumbridge serve [flags] [<root>]");
    expect(serve.stdout).toContain("--ttl");
    expect(serve.stdout).toContain("--detach");
    expect(serve.stdout).toContain("--stop");
    expect(serve.stdout).toContain("--direct-only");
    expect(serve.stdout).toContain("--relay-only");
    expect(serve.stdout).toContain("may still upgrade");
    expect(run.stdout).toContain("dumbridge run [flags] <script>");
    expect(run.stdout).toContain("connection path");
    expect(pullHelp.stdout).toContain(
      "dumbridge pull [flags] <remote-path> [<destination>]"
    );
    expect(pullHelp.stdout).toContain("connection path");
    expect(root.stdout).toContain("serve locally");
    expect(root.stdout).toContain("DUMBRIDGE_KEY");
    expect(serve.stdout).toContain("DUMBRIDGE_KEY");
    expect(run.stdout).toContain("DUMBRIDGE_KEY");
    expect(pullHelp.stdout).toContain("DUMBRIDGE_KEY");
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

  test("reports a missing bridge key without an Effect cause dump", async () => {
    const result = await invoke("run", "true");

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "dumbridge: No bridge key is set. Set DUMBRIDGE_KEY or pass --key-file <path> ('-' reads stdin).\n"
    );
  });

  test("reports an invalid bridge key without echoing its value", async () => {
    const rejectedPayload = "bm90LWEtcmVhbC1icmlkZ2Uta2V5";
    const result = await invokeWithEnvironment(
      { DUMBRIDGE_KEY: `dumbridge1_${rejectedPayload}` },
      "run",
      "true"
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("dumbridge: The bridge key is invalid.\n");
    expect(result.stderr).not.toContain(rejectedPayload);
  });

  test("reports an invalid pull path before attempting a connection", async () => {
    const link = mintKeyExpiringAt(Number.MAX_SAFE_INTEGER);
    const result = await invokeWithEnvironment(
      { DUMBRIDGE_KEY: link },
      "pull",
      "../secret"
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("dumbridge: The pull path is invalid.\n");
  });

  test("reports an expired bridge key before attempting a connection", async () => {
    const link = mintKeyExpiringAt(1);
    const result = await invokeWithEnvironment(
      { DUMBRIDGE_KEY: link },
      "run",
      "true"
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(expiredKeyMessage(1));
  });

  test("rejects an invalid serve --ttl before opening a bridge", async () => {
    const result = await invoke("serve", "--ttl", "sideways", "unused-root");

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "dumbridge: The --ttl value is invalid. Use a duration like '90 minutes' or '8 hours'.\n"
    );
  });

  test("commits to the relay only when the binding can use the proxy", () => {
    expect(
      resolveClientTransportOptions({ HTTPS_PROXY: "http://proxy" }, true)
    ).toEqual({
      options: {
        proxy: { _tag: "FromEnvironment" },
        reachability: "relay-only",
      },
      proxyFallback: false,
    });
    expect(resolveClientTransportOptions({}, true)).toEqual({
      options: { proxy: { _tag: "Disabled" } },
      proxyFallback: false,
    });
    expect(resolveClientTransportOptions({}, false)).toEqual({
      options: { proxy: { _tag: "Disabled" } },
      proxyFallback: false,
    });
  });

  test("falls back to a direct-capable dial when the binding cannot use the proxy", () => {
    // No proxy is requested and no reachability is forced, so the locator in
    // the bridge key keeps deciding the relay policy: a direct-only key stays
    // a direct-only attempt, and a relay-carrying key keeps its fallback.
    expect(
      resolveClientTransportOptions(
        { HTTPS_PROXY: "http://user:proxy-secret@proxy.example:3128" },
        false
      )
    ).toEqual({
      options: { proxy: { _tag: "Disabled" } },
      proxyFallback: true,
    });
  });

  test("names the proxy fallback in one branded stderr line", () => {
    expect(proxyFallbackNotice).toBe(
      "dumbridge: this environment sets a proxy, but the installed iroh binding cannot route through it; attempting a direct connection instead\n"
    );
  });

  test("warns once about an unusable proxy without leaking its URL", async () => {
    const link = mintKeyExpiringAt(1);
    const result = await invokeCli({
      args: ["run", "true"],
      environment: {
        DUMBRIDGE_KEY: link,
        HTTPS_PROXY: "http://user:proxy-secret@proxy.example:3128",
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(`${proxyFallbackNotice}${expiredKeyMessage(1)}`);
    expect(result.stderr).not.toContain("proxy-secret");
    expect(result.stderr).not.toContain("proxy.example");
  });

  test("names each connection path in one branded stderr line", () => {
    expect(connectionPathNotice("direct")).toBe(
      "dumbridge: connected directly\n"
    );
    expect(connectionPathNotice("relay")).toBe(
      "dumbridge: connected via relay\n"
    );
    expect(connectionPathNotice("unknown")).toBe(
      "dumbridge: connected (path unknown)\n"
    );
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
        _tag: "ServedRootChangedError",
        message: "served root changed after bridge start",
      })
    ).toBe("The served root changed during the pull.");
    expect(publicErrorMessage({ message: "   " })).toBe("dumbridge failed.");
  });

  test("states the pull limit ceilings and a recovery in limit messages", () => {
    expect(
      publicErrorMessage({
        _tag: "PullRemoteLimitError",
        path: "large.bin",
      })
    ).toBe(
      "The remote pull exceeded a safety limit: one pull may copy at most 4096 entries, 1 GiB per file, and 2 GiB in total; pull a smaller file or subdirectory."
    );
    expect(
      publicErrorMessage(
        new PullLimitError({
          limit: "total bytes",
          maximum: 2 * 1024 * 1024 * 1024,
          observed: 2 * 1024 * 1024 * 1024 + 1,
        })
      )
    ).toBe(
      "The pull exceeded the total bytes limit: at most 2 GiB allowed and 2147483649 bytes observed; pull a smaller file or subdirectory."
    );
    expect(
      publicErrorMessage(
        new PullLimitError({
          limit: "entries",
          maximum: 4096,
          observed: 4097,
        })
      )
    ).toBe(
      "The pull exceeded the entries limit: at most 4096 allowed and 4097 observed; pull a smaller file or subdirectory."
    );
  });

  test("scrubs bridge key tokens from every public error message", () => {
    expect(
      publicErrorMessage({
        message:
          "connect failed for dumbridge1_bm90LWEtcmVhbC1icmlkZ2Uta2V5 mid-request",
      })
    ).toBe("connect failed for dumbridge1_[REDACTED] mid-request");
  });
});

describe("dumbridge CLI key sources", () => {
  let keyDirectory = "";
  let keyFile = "";

  beforeEach(async () => {
    keyDirectory = await mkdtemp(join(tmpdir(), "dumbridge-key-"));
    keyFile = join(keyDirectory, "bridge.key");
  });

  afterEach(async () => {
    await rm(keyDirectory, { force: true, recursive: true });
  });

  test("run reads the key from --key-file and trims the trailing newline", async () => {
    const link = mintKeyExpiringAt(1);
    await writeFile(keyFile, `${link}\n`);

    const result = await invoke("run", "--key-file", keyFile, "true");

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(expiredKeyMessage(1));
  });

  test("pull reads the key from --key-file", async () => {
    const link = mintKeyExpiringAt(1);
    await writeFile(keyFile, `${link}\n`);

    const result = await invoke("pull", "--key-file", keyFile, "some.txt");

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(expiredKeyMessage(1));
  });

  test("run reads the key from stdin when --key-file is '-'", async () => {
    const link = mintKeyExpiringAt(1);

    const result = await invokeCli({
      args: ["run", "--key-file", "-", "true"],
      stdin: `${link}\n`,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(expiredKeyMessage(1));
  });

  test("pull reads the key from stdin when --key-file is '-'", async () => {
    const link = mintKeyExpiringAt(1);

    const result = await invokeCli({
      args: ["pull", "--key-file", "-", "some.txt"],
      stdin: `${link}\n`,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(expiredKeyMessage(1));
  });

  test("an explicit --key-file wins over DUMBRIDGE_KEY", async () => {
    const environmentKey = mintKeyExpiringAt(1000);
    const fileKey = mintKeyExpiringAt(2000);
    await writeFile(keyFile, `${fileKey}\n`);

    const result = await invokeCli({
      args: ["run", "--key-file", keyFile, "true"],
      environment: { DUMBRIDGE_KEY: environmentKey },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(expiredKeyMessage(2000));
  });

  test("rejects an empty key file with a branded message", async () => {
    await writeFile(keyFile, "\n");

    const result = await invoke("run", "--key-file", keyFile, "true");

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("dumbridge: The key file is empty.\n");
  });

  test("rejects a multi-line key file without echoing its content", async () => {
    await writeFile(keyFile, "not-a-key-line-one\nnot-a-key-line-two\n");

    const result = await invoke("run", "--key-file", keyFile, "true");

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "dumbridge: The key file must contain one bridge key on a single line.\n"
    );
    expect(`${result.stdout}${result.stderr}`).not.toContain("not-a-key-line");
  });

  test("reports an unreadable key file without a cause dump", async () => {
    const result = await invoke(
      "run",
      "--key-file",
      join(keyDirectory, "missing.key"),
      "true"
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("dumbridge: The key file could not be read.\n");
  });

  test("rejects empty stdin with a branded message", async () => {
    const result = await invokeCli({
      args: ["run", "--key-file", "-", "true"],
      stdin: "",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("dumbridge: Stdin provided no bridge key.\n");
  });

  test("documents the key resolution order in run and pull help", async () => {
    const [run, pullHelp] = await Promise.all([
      invoke("run", "--help"),
      invoke("pull", "--help"),
    ]);

    for (const help of [run, pullHelp]) {
      expect(help.exitCode).toBe(0);
      expect(help.stdout).toContain("--key-file");
      expect(help.stdout).toContain("DUMBRIDGE_KEY");
      expect(help.stdout).toContain("stdin");
    }
  });
});
