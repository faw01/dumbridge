import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  encodeBridgeKey,
  mintCapability,
  parseBridgeKey,
} from "@dumbridge/bridge-key";
import { Effect, Result } from "effect";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const bridgeKeyLine = /^DUMBRIDGE_KEY=(\S+)\r?\n/m;
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
let stateDirectory = "";
// Only pids observed in a record written by a real `serve --detach` may be
// killed in teardown; a pid from a hand-written fixture record could belong
// to an unrelated host process.
let spawnedServePids: number[] = [];

beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), "dumbridge-detach-cli-"));
  servedRoot = join(fixture, "served");
  stateDirectory = join(fixture, "state");
  spawnedServePids = [];
  await mkdir(servedRoot, { recursive: true });
});

// Tests must never leave an orphaned detached serve behind, even on failure.
afterEach(async () => {
  for (const pid of spawnedServePids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already stopped.
    }
  }
  await rm(fixture, { force: true, recursive: true });
});

const readRecord = async () =>
  JSON.parse(
    await readFile(join(stateDirectory, "detached-serve.json"), "utf8")
  );

const trackSpawnedServe = async () => {
  const record = await readRecord();
  spawnedServePids.push(record.pid);
  return record;
};

const cleanEnvironment = (extra: Record<string, string> = {}) => {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !proxyNames.has(name)) {
      environment[name] = value;
    }
  }
  return { ...environment, DUMBRIDGE_STATE_DIR: stateDirectory, ...extra };
};

const runCli = async (
  args: readonly string[],
  extra: Record<string, string> = {}
) => {
  const child = Bun.spawn([process.execPath, cli, ...args], {
    cwd: fixture,
    env: cleanEnvironment(extra),
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

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("dumbridge serve flags", () => {
  test("rejects contradictory or incomplete serve invocations", async () => {
    const [both, stopWithRoot, missingRoot, detachWithoutRoot] =
      await Promise.all([
        runCli(["serve", "--detach", "--stop"]),
        runCli(["serve", "--stop", servedRoot]),
        runCli(["serve"]),
        runCli(["serve", "--detach"]),
      ]);

    expect(both).toEqual({
      exitCode: 1,
      stderr: "dumbridge: Use either --detach or --stop, not both.\n",
      stdout: "",
    });
    expect(stopWithRoot).toEqual({
      exitCode: 1,
      stderr: "dumbridge: serve --stop does not take a root.\n",
      stdout: "",
    });
    expect(missingRoot).toEqual({
      exitCode: 1,
      stderr: "dumbridge: serve requires a <root> directory to share.\n",
      stdout: "",
    });
    expect(detachWithoutRoot).toEqual({
      exitCode: 1,
      stderr: "dumbridge: serve requires a <root> directory to share.\n",
      stdout: "",
    });
  });

  test("stopping without a detached serve fails", async () => {
    const result = await runCli(["serve", "--stop"]);

    expect(result).toEqual({
      exitCode: 1,
      stderr: "dumbridge: No detached serve is running.\n",
      stdout: "",
    });
  });

  test("stopping a stale record cleans it up without failing", async () => {
    await mkdir(stateDirectory, { recursive: true });
    // A start time far before the current boot marks the record stale no
    // matter which process owns the pid today, so nothing gets signaled.
    await writeFile(
      join(stateDirectory, "detached-serve.json"),
      JSON.stringify({
        pid: 2 ** 22 - 1,
        root: servedRoot,
        startedAtEpochMs: 1000,
      })
    );

    const result = await runCli(["serve", "--stop"]);

    expect(result).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: "Removed a stale detached serve record; nothing was running.\n",
    });
    const followUp = await runCli(["serve", "--stop"]);
    expect(followUp.exitCode).toBe(1);
  });
});

// Windows delivers no real SIGTERM, so the graceful detach lifecycle is
// exercised on POSIX; the state-file logic is covered everywhere by
// detached-serve.test.ts.
describe.skipIf(process.platform === "win32")(
  "dumbridge serve --detach",
  () => {
    test("detaches, serves requests, and stops through real CLI processes", async () => {
      const detach = await runCli(["serve", "--detach", servedRoot]);
      expect(detach.exitCode).toBe(0);
      expect(detach.stderr).toBe("");
      expect(detach.stdout.split("\n", 1)[0]).toBe(
        "Serving the selected directory read-only until dumbridge serve --stop."
      );
      expect(detach.stdout).toContain("The key expires at");
      const key = bridgeKeyLine.exec(detach.stdout)?.[1];
      if (key === undefined) {
        throw new Error("serve --detach did not print a bridge key");
      }

      const recordText = await readFile(
        join(stateDirectory, "detached-serve.json"),
        "utf8"
      );
      expect(recordText).not.toContain(key);
      const record = await trackSpawnedServe();
      expect(isAlive(record.pid)).toBe(true);

      await writeFile(join(servedRoot, "uncommitted.txt"), "not in git\n");
      const run = await runCli(["run", "cat uncommitted.txt"], {
        DUMBRIDGE_KEY: key,
      });
      expect(run).toEqual({
        exitCode: 0,
        stderr: "",
        stdout: "not in git\n",
      });

      const duplicate = await runCli(["serve", "--detach", servedRoot]);
      expect(duplicate.exitCode).toBe(1);
      expect(duplicate.stderr).toContain("already running");

      const stop = await runCli(["serve", "--stop"]);
      expect(stop).toEqual({
        exitCode: 0,
        stderr: "",
        stdout: "Stopped the detached serve.\n",
      });
      expect(isAlive(record.pid)).toBe(false);
      await expect(
        readFile(join(stateDirectory, "detached-serve.json"), "utf8")
      ).rejects.toThrow();
    }, 60_000);

    test("survives a session warning logged after its pipes close", async () => {
      const detach = await runCli(["serve", "--detach", servedRoot]);
      expect(detach.exitCode).toBe(0);
      const key = bridgeKeyLine.exec(detach.stdout)?.[1];
      if (key === undefined) {
        throw new Error("serve --detach did not print a bridge key");
      }
      const record = await trackSpawnedServe();
      await writeFile(join(servedRoot, "note.txt"), "alive\n");

      // A same-locator key with a wrong capability forces the child's
      // session-failure warning while its startup pipes are already destroyed;
      // the write must not kill the detached serve.
      const parsed = Effect.runSync(Effect.fromResult(parseBridgeKey(key)));
      const forged = encodeBridgeKey({
        capability: mintCapability(),
        expiresAt: parsed.expiresAt ?? Number.MAX_SAFE_INTEGER,
        locator: parsed.locator,
        transport: "iroh",
      });
      if (Result.isFailure(forged)) {
        throw new Error("could not build the wrong-capability key");
      }
      const denied = await runCli(["run", "cat note.txt"], {
        DUMBRIDGE_KEY: forged.success,
      });
      expect(denied.exitCode).toBe(1);

      expect(isAlive(record.pid)).toBe(true);
      const run = await runCli(["run", "cat note.txt"], { DUMBRIDGE_KEY: key });
      expect(run).toEqual({ exitCode: 0, stderr: "", stdout: "alive\n" });

      const stop = await runCli(["serve", "--stop"]);
      expect(stop.exitCode).toBe(0);
    }, 60_000);

    test("reports a failed startup instead of recording it", async () => {
      const result = await runCli([
        "serve",
        "--detach",
        join(fixture, "missing-root"),
      ]);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("dumbridge: The detached serve failed");
      await expect(
        readFile(join(stateDirectory, "detached-serve.json"), "utf8")
      ).rejects.toThrow();
    }, 60_000);
  }
);
