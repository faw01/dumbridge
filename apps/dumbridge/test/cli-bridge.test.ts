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
import { Result } from "effect";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const bridgeKeyLine = /^DUMBRIDGE_KEY=(\S+)\r?\n/m;
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

      // The banner shows the sanitized root display: the hostile directory
      // name keeps its text but loses every control character, so it cannot
      // fake a DUMBRIDGE_KEY line or inject an escape sequence.
      const bannerName =
        process.platform === "win32"
          ? "served"
          : "servedDUMBRIDGE_KEY=counterfeit[31m";
      const run = await runCli(["run", "cat uncommitted.txt"], environment);
      expect(run).toEqual({
        exitCode: 0,
        stderr: `dumbridge: serving '${bannerName}' as /workspace (read-only)\n`,
        stdout: "not in git\n",
      });
      expect(run.stderr).not.toContain("\u001b");
      expect(run.stderr).not.toMatch(bridgeKeyLine);

      const outside = await runCli(["run", "ls ../../Downloads"], environment);
      expect(outside.exitCode).not.toBe(0);
      expect(outside.stderr).toContain(
        "dumbridge: '/Downloads' is outside the served root; the served root is visible at /workspace.\n"
      );
      expect(outside.stderr).not.toContain("serving");

      const destination = join(cloudRoot, "pulled.txt");
      const pull = await runCli(
        ["pull", "uncommitted.txt", destination],
        environment
      );
      expect(pull).toMatchObject({ exitCode: 0, stderr: "" });
      expect(await Bun.file(destination).text()).toBe("not in git\n");

      const defaultPull = await runCli(
        ["pull", "uncommitted.txt"],
        environment
      );
      expect(defaultPull).toMatchObject({
        exitCode: 0,
        stderr: "",
      });
      expect(defaultPull.stdout).toContain("to ./uncommitted.txt.");
      expect(await Bun.file(join(cloudRoot, "uncommitted.txt")).text()).toBe(
        "not in git\n"
      );

      const missing = await runCli(["pull", "missing.txt"], environment);
      expect(missing).toEqual({
        exitCode: 1,
        stderr: "dumbridge: The remote path does not exist.\n",
        stdout: "",
      });

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
      expect(rejected).toEqual({
        exitCode: 1,
        stderr:
          "dumbridge: The bridge rejected DUMBRIDGE_KEY: the key does not match this bridge. Copy the current key printed by dumbridge serve.\n",
        stdout: "",
      });
    } finally {
      server.kill();
      await server.exited;
    }
  }, 40_000);
});
