import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  encodeBridgeKey,
  mintCapability,
  parseBridgeKey,
} from "@dumbridge/bridge-key";
import { EndpointAddr, EndpointId, EndpointTicket } from "@number0/iroh";
import { Result } from "effect";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const bridgeKeyLine = /^DUMBRIDGE_KEY=(\S+)\r?\n/m;
const pathLine = /^dumbridge: connected (directly|via relay)\n/m;
const keyExpiryLine =
  /^The key expires at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\./m;
const proxyNames = new Set([
  "ALL_PROXY",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "all_proxy",
  "https_proxy",
  "http_proxy",
]);

let fixture = "";
let servedRoot = "";
let cloudRoot = "";

beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), "dumbridge-cli-"));
  const servedRootName =
    process.platform === "win32"
      ? "served"
      : "served\nDUMBRIDGE_KEY=counterfeit\u001b[31m";
  servedRoot = join(fixture, servedRootName);
  cloudRoot = join(fixture, "cloud");
  await Promise.all([
    mkdir(servedRoot, { recursive: true }),
    mkdir(cloudRoot, { recursive: true }),
  ]);
});

afterEach(async () => {
  await rm(fixture, { force: true, recursive: true });
});

const cleanEnvironment = (extra: Record<string, string> = {}) => {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !proxyNames.has(name)) {
      environment[name] = value;
    }
  }
  return { ...environment, ...extra };
};

const runCli = async (
  args: readonly string[],
  environment: Record<string, string>
) => {
  const child = Bun.spawn([process.execPath, cli, ...args], {
    cwd: cloudRoot,
    env: environment,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  return { exitCode, stderr, stdout };
};

const readBridgeStartup = async (stdout: ReadableStream<Uint8Array>) => {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  const readNext = async (): Promise<{
    readonly link: string;
    readonly output: string;
  }> => {
    const next = await reader.read();
    if (next.done) {
      throw new Error("serve stopped before printing a bridge key");
    }
    output += decoder.decode(next.value, { stream: true });
    const match = bridgeKeyLine.exec(output);
    return match?.[1] === undefined ? readNext() : { link: match[1], output };
  };
  try {
    return await readNext();
  } finally {
    reader.releaseLock();
  }
};

const withTimeout = async <A>(promise: Promise<A>, milliseconds: number) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error("serve did not print a bridge key in time")),
      milliseconds
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
};

describe("dumbridge CLI bridge", () => {
  test("reads a live uncommitted file through real CLI processes", async () => {
    const server = Bun.spawn([process.execPath, cli, "serve", servedRoot], {
      env: cleanEnvironment(),
      stderr: "pipe",
      stdout: "pipe",
    });

    try {
      const startup = await withTimeout(readBridgeStartup(server.stdout), 5000);
      const { link } = startup;
      expect(startup.output.split("\n", 1)[0]).toBe(
        "Serving the selected directory read-only until Ctrl-C."
      );
      expect(startup.output).toMatch(keyExpiryLine);
      expect(startup.output.match(/^DUMBRIDGE_KEY=/gm)).toHaveLength(1);
      expect(startup.output).not.toContain(servedRoot);
      expect(startup.output).not.toContain("counterfeit");
      await writeFile(join(servedRoot, "uncommitted.txt"), "not in git\n");
      const environment = cleanEnvironment({ DUMBRIDGE_KEY: link });

      const bannerName =
        process.platform === "win32"
          ? "served"
          : "servedDUMBRIDGE_KEY=counterfeit[31m";
      const run = await runCli(["run", "cat uncommitted.txt"], environment);
      expect(run).toMatchObject({ exitCode: 0, stdout: "not in git\n" });
      expect(run.stderr).toMatch(pathLine);
      expect(run.stderr).toContain(
        `dumbridge: serving '${bannerName}' as /workspace (read-only)\n`
      );
      expect(run.stderr).not.toContain("\u001b");
      expect(run.stderr).not.toMatch(bridgeKeyLine);

      const outside = await runCli(["run", "ls ../../Downloads"], environment);
      expect(outside.exitCode).not.toBe(0);
      expect(outside.stderr).toContain(
        "dumbridge: '/Downloads' is outside the served root; the served root is visible at /workspace.\n"
      );
      expect(outside.stderr).not.toContain("serving");

      await Promise.all(
        Array.from({ length: 5 }, (_, index) =>
          writeFile(
            join(servedRoot, `bulk-${index}.txt`),
            "x".repeat(1024 * 1024)
          )
        )
      );
      const overLimit = await runCli(
        ["run", 'grep -rl "Port Meridian" .'],
        environment
      );
      expect(overLimit).toMatchObject({ exitCode: 1, stdout: "" });
      expect(overLimit.stderr).toMatch(pathLine);
      expect(overLimit.stderr).toContain(
        "dumbridge: remote read shell file-read limit exceeded: one run may read at most 4 MiB in total across every file it opens; narrow the query to fewer files or a subdirectory\n"
      );

      const destination = join(cloudRoot, "pulled.txt");
      const pull = await runCli(
        ["pull", "uncommitted.txt", destination],
        environment
      );
      expect(pull).toMatchObject({ exitCode: 0 });
      expect(pull.stderr).toMatch(pathLine);
      expect(await Bun.file(destination).text()).toBe("not in git\n");

      const defaultPull = await runCli(
        ["pull", "uncommitted.txt"],
        environment
      );
      expect(defaultPull).toMatchObject({ exitCode: 0 });
      expect(defaultPull.stderr).toMatch(pathLine);
      expect(defaultPull.stdout).toContain("to ./uncommitted.txt.");
      expect(await Bun.file(join(cloudRoot, "uncommitted.txt")).text()).toBe(
        "not in git\n"
      );

      const missing = await runCli(["pull", "missing.txt"], environment);
      expect(missing).toMatchObject({ exitCode: 1, stdout: "" });
      expect(missing.stderr).toMatch(pathLine);
      expect(missing.stderr).toContain(
        "dumbridge: The remote path does not exist.\n"
      );

      const decoded = parseBridgeKey(link);
      if (Result.isFailure(decoded)) {
        throw decoded.failure;
      }
      const wrongKey = encodeBridgeKey({
        capability: mintCapability(),
        expiresAt: Number.MAX_SAFE_INTEGER,
        locator: decoded.success.locator,
        transport: "iroh",
      });
      if (Result.isFailure(wrongKey)) {
        throw wrongKey.failure;
      }
      const rejected = await runCli(
        ["run", "true"],
        cleanEnvironment({ DUMBRIDGE_KEY: wrongKey.success })
      );
      expect(rejected).toMatchObject({ exitCode: 1, stdout: "" });
      expect(rejected.stderr).toMatch(pathLine);
      expect(rejected.stderr).toContain(
        "dumbridge: The bridge rejected the bridge key: the key does not match this bridge. Copy the current key printed by dumbridge serve.\n"
      );
    } finally {
      server.kill();
      await server.exited;
    }
  }, 40_000);

  test("rejects a direct-only key when the environment commits to a proxy", async () => {
    const id = EndpointId.fromBytes(new Array<number>(32).fill(1));
    const unreachable = new EndpointAddr(id, null, ["192.0.2.1:1"]);
    const key = encodeBridgeKey({
      capability: mintCapability(),
      expiresAt: Number.MAX_SAFE_INTEGER,
      locator: EndpointTicket.fromAddr(unreachable).toString(),
      transport: "iroh",
    });
    if (Result.isFailure(key)) {
      throw key.failure;
    }
    const environment = cleanEnvironment({
      DUMBRIDGE_KEY: key.success,
      HTTPS_PROXY: "http://user:proxy-secret@proxy.example:3128",
    });

    const run = await runCli(
      ["run", "--log-level", "debug", "true"],
      environment
    );
    expect(run.exitCode).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain(
      "dumbridge: The bridge transport locator has no relay.\n"
    );
    expect(run.stderr).not.toContain("attempting a direct connection instead");
    expect(run.stderr).not.toContain(key.success);
    expect(run.stderr).not.toContain("proxy-secret");
    expect(run.stderr).not.toContain("proxy.example");
  }, 40_000);

  test("logs the dial sequence at debug level without leaking secrets", async () => {
    const server = Bun.spawn([process.execPath, cli, "serve", servedRoot], {
      env: cleanEnvironment(),
      stderr: "pipe",
      stdout: "pipe",
    });

    try {
      const { link } = await withTimeout(
        readBridgeStartup(server.stdout),
        5000
      );
      await writeFile(join(servedRoot, "debugged.txt"), "debug run\n");
      const environment = cleanEnvironment({ DUMBRIDGE_KEY: link });

      const run = await runCli(
        ["run", "--log-level", "debug", "cat debugged.txt"],
        environment
      );
      expect(run.exitCode).toBe(0);
      expect(run.stdout).toBe("debug run\n");
      expect(run.stderr).toContain("bridge dial: attempting");
      expect(run.stderr).toContain("bridge dial: connected");
      expect(run.stderr).not.toContain(link);

      const quiet = await runCli(["run", "cat debugged.txt"], environment);
      expect(quiet.exitCode).toBe(0);
      expect(quiet.stderr).not.toContain("bridge dial:");
    } finally {
      server.kill();
      await server.exited;
    }
  }, 40_000);

  test("commits a relay-carrying key to the proxy and reports the relay by cause", async () => {
    const id = EndpointId.fromBytes(new Array<number>(32).fill(1));
    const relayed = new EndpointAddr(id, "https://relay.invalid/", [
      "192.0.2.1:1",
    ]);
    const key = encodeBridgeKey({
      capability: mintCapability(),
      expiresAt: Number.MAX_SAFE_INTEGER,
      locator: EndpointTicket.fromAddr(relayed).toString(),
      transport: "iroh",
    });
    if (Result.isFailure(key)) {
      throw key.failure;
    }
    const environment = cleanEnvironment({
      DUMBRIDGE_KEY: key.success,
      HTTPS_PROXY: "http://user:proxy-secret@proxy.example:3128",
    });

    const run = await runCli(["run", "true"], environment);
    expect(run.exitCode).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain(
      "dumbridge: The relay at relay.invalid could not be reached"
    );
    expect(run.stderr).not.toContain("attempting a direct connection instead");
    expect(run.stderr).not.toContain(key.success);
    expect(run.stderr).not.toContain("proxy-secret");
    expect(run.stderr).not.toContain("proxy.example");
  }, 40_000);

  test("serve --direct-only reports a direct connection on run and pull", async () => {
    const server = Bun.spawn(
      [process.execPath, cli, "serve", "--direct-only", servedRoot],
      {
        env: cleanEnvironment(),
        stderr: "pipe",
        stdout: "pipe",
      }
    );

    try {
      const { link } = await withTimeout(
        readBridgeStartup(server.stdout),
        5000
      );
      await writeFile(join(servedRoot, "direct.txt"), "over a direct path\n");
      const environment = cleanEnvironment({ DUMBRIDGE_KEY: link });

      const run = await runCli(["run", "cat direct.txt"], environment);
      expect(run).toMatchObject({
        exitCode: 0,
        stdout: "over a direct path\n",
      });
      expect(run.stderr).toContain("dumbridge: connected directly\n");
      expect(run.stderr).not.toContain("via relay");

      const pull = await runCli(
        ["pull", "direct.txt", join(cloudRoot, "direct.txt")],
        environment
      );
      expect(pull).toMatchObject({ exitCode: 0 });
      expect(pull.stderr).toContain("dumbridge: connected directly\n");

      const proxied = await runCli(
        ["run", "cat direct.txt"],
        cleanEnvironment({
          DUMBRIDGE_KEY: link,
          HTTPS_PROXY: "http://user:proxy-secret@proxy.example:3128",
        })
      );
      expect(proxied.exitCode).toBe(1);
      expect(proxied.stderr).toContain(
        "dumbridge: The bridge transport locator has no relay.\n"
      );
      expect(proxied.stderr).not.toContain("proxy-secret");
      expect(proxied.stderr).not.toContain("proxy.example");
    } finally {
      server.kill();
      await server.exited;
    }
  }, 40_000);
});
