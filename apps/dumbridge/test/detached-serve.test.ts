import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import {
  DetachedServeError,
  detachServe,
  type ServeProcessControl,
  stopDetachedServe,
} from "../src/detached-serve";

let stateDirectory = "";

beforeEach(async () => {
  stateDirectory = await mkdtemp(join(tmpdir(), "dumbridge-detach-"));
});

afterEach(async () => {
  await rm(stateDirectory, { force: true, recursive: true });
});

const recordPath = () => join(stateDirectory, "detached-serve.json");

const writeRecord = (record: {
  readonly pid: number;
  readonly root: string;
  readonly startedAtEpochMs: number;
}) => writeFile(recordPath(), JSON.stringify(record));

const readRecordText = () => readFile(recordPath(), "utf8");

const recordExists = async () => {
  try {
    await readRecordText();
    return true;
  } catch {
    return false;
  }
};

const makeControl = (overrides: {
  readonly alivePids?: ReadonlySet<number>;
  readonly bootTimeMs?: number;
  readonly spawnedKey?: string;
  readonly spawnedPid?: number;
  readonly terminateFails?: boolean;
  readonly terminateKills?: boolean;
}) => {
  const alive = new Set(overrides.alivePids ?? []);
  const calls = { spawns: [] as string[], terminated: [] as number[] };
  const firstTermination = Promise.withResolvers<void>();
  const control: ServeProcessControl = {
    bootTimeMs: Effect.sync(() => overrides.bootTimeMs ?? 0),
    isAlive: (pid) => Effect.sync(() => alive.has(pid)),
    spawnDetachedServe: ({ root }) =>
      Effect.sync(() => {
        calls.spawns.push(root);
        const pid = overrides.spawnedPid ?? 4242;
        alive.add(pid);
        return { key: overrides.spawnedKey ?? "dumbridge1_test", pid };
      }),
    terminate: (pid) =>
      Effect.suspend(() => {
        calls.terminated.push(pid);
        firstTermination.resolve();
        if (overrides.terminateFails) {
          return Effect.fail(
            new DetachedServeError({
              message: "The detached serve could not be signaled.",
              reason: "terminate-failed",
            })
          );
        }
        if (overrides.terminateKills !== false) {
          alive.delete(pid);
        }
        return Effect.void;
      }),
  };
  return { alive, calls, control, firstTermination };
};

describe("detachServe", () => {
  test("spawns a detached serve and records it without the key", async () => {
    const { calls, control } = makeControl({
      spawnedKey: "dumbridge1_secret",
      spawnedPid: 5150,
    });

    const startup = await Effect.runPromise(
      detachServe({ control, root: "some-root", stateDirectory })
    );

    expect(startup).toEqual({ key: "dumbridge1_secret", pid: 5150 });
    expect(calls.spawns).toEqual(["some-root"]);
    const text = await readRecordText();
    expect(text).not.toContain("dumbridge1_secret");
    const record = JSON.parse(text);
    expect(record.pid).toBe(5150);
    expect(record.root).toBe(resolve("some-root"));
    expect(record.startedAtEpochMs).toBeGreaterThan(0);
  });

  test("refuses a record that would land inside the served root", async () => {
    const { calls, control } = makeControl({});

    const error = await Effect.runPromise(
      detachServe({
        control,
        root: join(stateDirectory, ".."),
        stateDirectory,
      }).pipe(Effect.flip)
    );

    expect(error).toMatchObject({
      _tag: "DetachedServeError",
      reason: "state-overlap",
    });
    expect(calls.spawns).toEqual([]);
    expect(await recordExists()).toBe(false);
  });

  test.skipIf(process.platform === "win32")(
    "refuses an overlap reached through a symlinked root",
    async () => {
      const { calls, control } = makeControl({});
      // The link lives inside the fixture but canonically resolves to the
      // state directory's parent, so only canonical comparison catches it.
      const linkedRoot = join(stateDirectory, "linked-root");
      await symlink(join(stateDirectory, ".."), linkedRoot);

      const error = await Effect.runPromise(
        detachServe({ control, root: linkedRoot, stateDirectory }).pipe(
          Effect.flip
        )
      );

      expect(error).toMatchObject({
        _tag: "DetachedServeError",
        reason: "state-overlap",
      });
      expect(calls.spawns).toEqual([]);
    }
  );

  test("refuses to start when a detached serve is already running", async () => {
    await writeRecord({ pid: 77, root: "/served", startedAtEpochMs: 2000 });
    const { calls, control } = makeControl({
      alivePids: new Set([77]),
      bootTimeMs: 1000,
    });

    const error = await Effect.runPromise(
      detachServe({ control, root: "another-root", stateDirectory }).pipe(
        Effect.flip
      )
    );

    expect(error).toMatchObject({
      _tag: "DetachedServeError",
      reason: "already-running",
    });
    expect(calls.spawns).toEqual([]);
    expect(calls.terminated).toEqual([]);
  });

  test("replaces a record whose process is gone", async () => {
    await writeRecord({ pid: 77, root: "/served", startedAtEpochMs: 2000 });
    const { calls, control } = makeControl({
      bootTimeMs: 1000,
      spawnedPid: 88,
    });

    const startup = await Effect.runPromise(
      detachServe({ control, root: "fresh-root", stateDirectory })
    );

    expect(startup.pid).toBe(88);
    expect(calls.terminated).toEqual([]);
    expect(JSON.parse(await readRecordText()).pid).toBe(88);
  });

  test("treats a live pid recorded before the current boot as recycled", async () => {
    await writeRecord({ pid: 77, root: "/served", startedAtEpochMs: 500 });
    const { calls, control } = makeControl({
      alivePids: new Set([77]),
      bootTimeMs: 100_000,
      spawnedPid: 99,
    });

    const startup = await Effect.runPromise(
      detachServe({ control, root: "fresh-root", stateDirectory })
    );

    expect(startup.pid).toBe(99);
    expect(calls.terminated).toEqual([]);
  });

  test("loses a detach race and terminates its own child", async () => {
    const winner = { pid: 300, root: "/served", startedAtEpochMs: 2000 };
    const calls = { spawns: [] as string[], terminated: [] as number[] };
    // The other invocation wins the record while this child is starting up.
    const control: ServeProcessControl = {
      bootTimeMs: Effect.sync(() => 0),
      isAlive: () => Effect.sync(() => true),
      spawnDetachedServe: ({ root }) =>
        Effect.promise(async () => {
          calls.spawns.push(root);
          await writeRecord(winner);
          return { key: "dumbridge1_loser", pid: 301 };
        }),
      terminate: (pid) =>
        Effect.sync(() => {
          calls.terminated.push(pid);
        }),
    };

    const error = await Effect.runPromise(
      detachServe({ control, root: "some-root", stateDirectory }).pipe(
        Effect.flip
      )
    );

    expect(error).toMatchObject({
      _tag: "DetachedServeError",
      reason: "already-running",
    });
    expect(calls.terminated).toEqual([301]);
    expect(JSON.parse(await readRecordText()).pid).toBe(300);
  });

  test("terminates the fresh child when the record cannot be written", async () => {
    const { calls, control } = makeControl({ spawnedPid: 123 });
    const fileBlockingDirectory = join(stateDirectory, "occupied");
    await writeFile(fileBlockingDirectory, "not a directory\n");

    const error = await Effect.runPromise(
      detachServe({
        control,
        root: "some-root",
        stateDirectory: fileBlockingDirectory,
      }).pipe(Effect.flip)
    );

    expect(error).toMatchObject({
      _tag: "DetachedServeError",
      reason: "state-io",
    });
    expect(calls.terminated).toEqual([123]);
  });
});

describe("stopDetachedServe", () => {
  test("fails when no detached serve is recorded", async () => {
    const { calls, control } = makeControl({});

    const error = await Effect.runPromise(
      stopDetachedServe({ control, stateDirectory }).pipe(Effect.flip)
    );

    expect(error).toMatchObject({
      _tag: "DetachedServeError",
      reason: "not-running",
    });
    expect(calls.terminated).toEqual([]);
  });

  test("removes an unreadable record without signaling anything", async () => {
    await writeFile(recordPath(), "not json");
    const { calls, control } = makeControl({});

    const result = await Effect.runPromise(
      stopDetachedServe({ control, stateDirectory })
    );

    expect(result).toEqual({ type: "stale-record-removed" });
    expect(calls.terminated).toEqual([]);
    expect(await recordExists()).toBe(false);
  });

  test("removes a record whose process is gone", async () => {
    await writeRecord({ pid: 77, root: "/served", startedAtEpochMs: 2000 });
    const { calls, control } = makeControl({ bootTimeMs: 1000 });

    const result = await Effect.runPromise(
      stopDetachedServe({ control, stateDirectory })
    );

    expect(result).toEqual({ type: "stale-record-removed" });
    expect(calls.terminated).toEqual([]);
    expect(await recordExists()).toBe(false);
  });

  test("does not signal a live pid recorded before the current boot", async () => {
    await writeRecord({ pid: 77, root: "/served", startedAtEpochMs: 500 });
    const { calls, control } = makeControl({
      alivePids: new Set([77]),
      bootTimeMs: 100_000,
    });

    const result = await Effect.runPromise(
      stopDetachedServe({ control, stateDirectory })
    );

    expect(result).toEqual({ type: "stale-record-removed" });
    expect(calls.terminated).toEqual([]);
    expect(await recordExists()).toBe(false);
  });

  test("terminates a live detached serve and removes the record", async () => {
    await writeRecord({ pid: 77, root: "/served", startedAtEpochMs: 2000 });
    const { calls, control } = makeControl({
      alivePids: new Set([77]),
      bootTimeMs: 1000,
    });

    const result = await Effect.runPromise(
      stopDetachedServe({ control, stateDirectory })
    );

    expect(result).toEqual({ pid: 77, type: "stopped" });
    expect(calls.terminated).toEqual([77]);
    expect(await recordExists()).toBe(false);
  });

  test("does not remove a record replaced while stopping", async () => {
    await writeRecord({ pid: 77, root: "/served", startedAtEpochMs: 2000 });
    const alive = new Set([77]);
    const calls = { terminated: [] as number[] };
    // A concurrent detach replaces the record while this stop is waiting for
    // the old process to exit; the newer record must survive.
    const replacement = { pid: 400, root: "/served", startedAtEpochMs: 3000 };
    const control: ServeProcessControl = {
      bootTimeMs: Effect.sync(() => 1000),
      isAlive: (pid) => Effect.sync(() => alive.has(pid)),
      spawnDetachedServe: () => Effect.die("spawning is not used in this test"),
      terminate: (pid) =>
        Effect.promise(async () => {
          calls.terminated.push(pid);
          alive.delete(pid);
          await writeRecord(replacement);
        }),
    };

    const result = await Effect.runPromise(
      stopDetachedServe({ control, stateDirectory })
    );

    expect(result).toEqual({ pid: 77, type: "stopped" });
    expect(calls.terminated).toEqual([77]);
    expect(JSON.parse(await readRecordText()).pid).toBe(400);
  });

  test("keeps the record and fails when the process does not exit", async () => {
    await writeRecord({ pid: 77, root: "/served", startedAtEpochMs: 2000 });
    const { calls, control, firstTermination } = makeControl({
      alivePids: new Set([77]),
      bootTimeMs: 1000,
      terminateKills: false,
    });

    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* stopDetachedServe({
          control,
          stateDirectory,
        }).pipe(Effect.flip, Effect.forkChild);
        yield* Effect.promise(() => firstTermination.promise);
        yield* TestClock.adjust("30 seconds");
        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(TestClock.layer({ warningDelay: "10 seconds" })))
    );

    expect(error).toMatchObject({
      _tag: "DetachedServeError",
      reason: "stop-timeout",
    });
    expect(calls.terminated).toEqual([77]);
    expect(await recordExists()).toBe(true);
  });

  test("keeps the record when the process cannot be signaled", async () => {
    await writeRecord({ pid: 77, root: "/served", startedAtEpochMs: 2000 });
    const { calls, control } = makeControl({
      alivePids: new Set([77]),
      bootTimeMs: 1000,
      terminateFails: true,
    });

    const error = await Effect.runPromise(
      stopDetachedServe({ control, stateDirectory }).pipe(Effect.flip)
    );

    expect(error).toMatchObject({
      _tag: "DetachedServeError",
      reason: "terminate-failed",
    });
    expect(calls.terminated).toEqual([77]);
    expect(await recordExists()).toBe(true);
  });
});
