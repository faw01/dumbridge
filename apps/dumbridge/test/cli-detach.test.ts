import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
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
const pathLine = /^dumbridge: connected (directly|via relay)\n/m;
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
let spawnedServePids: number[] = [];

// The fixture is realpath'd so the roots the tests pass are already
// canonical and error messages naming the root can be compared literally.
beforeEach(async () => {
  fixture = await realpath(
    await mkdtemp(join(tmpdir(), "dumbridge-detach-cli-"))
  );
  servedRoot = join(fixture, "served");
  stateDirectory = join(fixture, "state");
  spawnedServePids = [];
  await mkdir(servedRoot, { recursive: true });
});

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

// The tests never derive record file names from a root: they read whatever
// record files the CLI left in the state directory.
const readRecordTexts = async () => {
  let names: string[];
  try {
    names = await readdir(stateDirectory);
  } catch {
    return [];
  }
  return await Promise.all(
    names
      .filter((name) => name.startsWith("detached-serve"))
      .map((name) => readFile(join(stateDirectory, name), "utf8"))
  );
};

const readRecords = async () =>
  (await readRecordTexts()).map((text) => JSON.parse(text));

const trackSpawnedServe = async () => {
  const records = await readRecords();
  for (const record of records) {
    if (!spawnedServePids.includes(record.pid)) {
      spawnedServePids.push(record.pid);
    }
  }
  const [record] = records;
  if (record === undefined) {
    throw new Error("no detached serve record was written");
  }
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
    const [both, missingRoot, detachWithoutRoot] = await Promise.all([
      runCli(["serve", "--detach", "--stop"]),
      runCli(["serve"]),
      runCli(["serve", "--detach"]),
    ]);

    expect(both).toEqual({
      exitCode: 1,
      stderr: "dumbridge: Use either --detach or --stop, not both.\n",
      stdout: "",
    });
    const [bothPaths, stopWithPath] = await Promise.all([
      runCli(["serve", "--direct-only", "--relay-only", servedRoot]),
      runCli(["serve", "--stop", "--relay-only"]),
    ]);
    expect(bothPaths).toEqual({
      exitCode: 1,
      stderr:
        "dumbridge: Use either --direct-only or --relay-only, not both.\n",
      stdout: "",
    });
    expect(stopWithPath).toEqual({
      exitCode: 1,
      stderr:
        "dumbridge: serve --stop does not take --direct-only or --relay-only.\n",
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

  test("rejects --status combined with any other serve request", async () => {
    const [withDetach, withStop, withRoot, withTtl, withPath] =
      await Promise.all([
        runCli(["serve", "--status", "--detach"]),
        runCli(["serve", "--status", "--stop"]),
        runCli(["serve", "--status", servedRoot]),
        runCli(["serve", "--status", "--ttl", "1 hour"]),
        runCli(["serve", "--status", "--relay-only"]),
      ]);

    expect(withDetach).toEqual({
      exitCode: 1,
      stderr: "dumbridge: Use either --status or --detach, not both.\n",
      stdout: "",
    });
    expect(withStop).toEqual({
      exitCode: 1,
      stderr: "dumbridge: Use either --status or --stop, not both.\n",
      stdout: "",
    });
    expect(withRoot).toEqual({
      exitCode: 1,
      stderr: "dumbridge: serve --status does not take a root.\n",
      stdout: "",
    });
    expect(withTtl).toEqual({
      exitCode: 1,
      stderr: "dumbridge: serve --status does not take a --ttl.\n",
      stdout: "",
    });
    expect(withPath).toEqual({
      exitCode: 1,
      stderr:
        "dumbridge: serve --status does not take --direct-only or --relay-only.\n",
      stdout: "",
    });
  });

  test("stopping without a detached serve fails", async () => {
    const [bare, withRoot] = await Promise.all([
      runCli(["serve", "--stop"]),
      runCli(["serve", "--stop", servedRoot]),
    ]);

    expect(bare).toEqual({
      exitCode: 1,
      stderr: "dumbridge: No detached serve is running.\n",
      stdout: "",
    });
    expect(withRoot).toEqual({
      exitCode: 1,
      stderr: `dumbridge: No detached serve is running for ${servedRoot}.\n`,
      stdout: "",
    });
  });

  test("status with no detached serves prints one line and exits zero", async () => {
    const result = await runCli(["serve", "--status"]);

    expect(result).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: "No detached serves are running.\n",
    });
  });

  test("status lists live serves one per line and prunes stale records", async () => {
    await mkdir(stateDirectory, { recursive: true });
    // Seeded records stand in for serves detached earlier: the test runner's
    // own pid is live in this boot, so its records list; the impossible pid
    // is dead, so its record must be pruned. Status discovers records by
    // file name shape, so the hashes need not match the roots.
    const startedAtEpochMs = Date.now();
    const startedAtIso = new Date(startedAtEpochMs).toISOString();
    const rootA = join(fixture, "served-a");
    const rootB = join(fixture, "served-b");
    await Promise.all([
      writeFile(
        join(stateDirectory, `detached-serve-${"a".repeat(64)}.json`),
        JSON.stringify({
          expiresAtEpochMs: 1_798_761_600_000,
          pid: process.pid,
          root: rootA,
          startedAtEpochMs,
        })
      ),
      writeFile(
        join(stateDirectory, `detached-serve-${"b".repeat(64)}.json`),
        JSON.stringify({
          pid: process.pid,
          root: rootB,
          startedAtEpochMs,
        })
      ),
      writeFile(
        join(stateDirectory, `detached-serve-${"c".repeat(64)}.json`),
        JSON.stringify({
          pid: 2 ** 22 - 1,
          root: join(fixture, "served-c"),
          startedAtEpochMs,
        })
      ),
    ]);

    const result = await runCli(["serve", "--status"]);

    expect(result).toEqual({
      exitCode: 0,
      stderr: "",
      stdout:
        `${rootA}\tpid ${process.pid}\tstarted ${startedAtIso}\tkey expires 2027-01-01T00:00:00.000Z\n` +
        `${rootB}\tpid ${process.pid}\tstarted ${startedAtIso}\tkey expiry unknown\n`,
    });
    expect((await readRecordTexts()).length).toBe(2);
  });

  test("stopping a stale record cleans it up without failing", async () => {
    await mkdir(stateDirectory, { recursive: true });
    // Simulates a record left by a past process. A bare stop discovers
    // records by their file name shape, so the hash need not match the root.
    await writeFile(
      join(stateDirectory, `detached-serve-${"0".repeat(64)}.json`),
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

      const [recordText] = await readRecordTexts();
      expect(recordText).toBeDefined();
      expect(recordText).not.toContain(key);
      const record = await trackSpawnedServe();
      expect(isAlive(record.pid)).toBe(true);
      expect(record.expiresAtEpochMs).toBeGreaterThan(Date.now());

      await writeFile(join(servedRoot, "uncommitted.txt"), "not in git\n");
      const run = await runCli(["run", "cat uncommitted.txt"], {
        DUMBRIDGE_KEY: key,
      });
      expect(run).toMatchObject({ exitCode: 0, stdout: "not in git\n" });
      expect(run.stderr).toContain(
        "dumbridge: serving 'served' as /workspace (read-only)\n"
      );
      expect(run.stderr).toMatch(pathLine);

      const duplicate = await runCli(["serve", "--detach", servedRoot]);
      expect(duplicate.exitCode).toBe(1);
      expect(duplicate.stderr).toContain(`already running for ${servedRoot}`);

      const status = await runCli(["serve", "--status"]);
      expect(status.exitCode).toBe(0);
      expect(status.stderr).toBe("");
      expect(status.stdout).toBe(
        `${servedRoot}\tpid ${record.pid}\tstarted ${new Date(record.startedAtEpochMs).toISOString()}\tkey expires ${new Date(record.expiresAtEpochMs).toISOString()}\n`
      );

      const stop = await runCli(["serve", "--stop", servedRoot]);
      expect(stop).toEqual({
        exitCode: 0,
        stderr: "",
        stdout: "Stopped the detached serve.\n",
      });
      expect(isAlive(record.pid)).toBe(false);
      expect(await readRecords()).toEqual([]);

      const afterStop = await runCli(["serve", "--status"]);
      expect(afterStop).toEqual({
        exitCode: 0,
        stderr: "",
        stdout: "No detached serves are running.\n",
      });
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
      expect(run).toMatchObject({ exitCode: 0, stdout: "alive\n" });
      expect(run.stderr).toContain(
        "dumbridge: serving 'served' as /workspace (read-only)\n"
      );
      expect(run.stderr).toMatch(pathLine);

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
      expect(await readRecords()).toEqual([]);
    }, 60_000);
  }
);
