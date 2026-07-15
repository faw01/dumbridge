import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import {
  DetachedServeError,
  detachServe,
  type DetachedSpawnRequest,
  type ServeProcessControl,
  stopDetachedServe,
} from "../../src/bridge/detached-serve";

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
}) => Effect.promise(() => writeFile(recordPath(), JSON.stringify(record)));

const readRecordText = Effect.promise(() => readFile(recordPath(), "utf8"));

const recordExists = Effect.promise(async () => {
  try {
    await readFile(recordPath(), "utf8");
    return true;
  } catch {
    return false;
  }
});

const makeControl = (overrides: {
  readonly alivePids?: ReadonlySet<number>;
  readonly bootTimeMs?: number;
  readonly spawnedKey?: string;
  readonly spawnedPid?: number;
  readonly terminateFails?: boolean;
  readonly terminateKills?: boolean;
}) => {
  const alive = new Set(overrides.alivePids ?? []);
  const calls = {
    requests: [] as DetachedSpawnRequest[],
    spawns: [] as string[],
    terminated: [] as number[],
  };
  const firstTermination = Promise.withResolvers<void>();
  const control: ServeProcessControl = {
    bootTimeMs: Effect.sync(() => overrides.bootTimeMs ?? 0),
    isAlive: (pid) => Effect.sync(() => alive.has(pid)),
    spawnDetachedServe: (request) =>
      Effect.sync(() => {
        calls.requests.push(request);
        calls.spawns.push(request.root);
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
  it.effect("spawns a detached serve and records it without the key", () =>
    Effect.gen(function* () {
      const { calls, control } = makeControl({
        spawnedKey: "dumbridge1_secret",
        spawnedPid: 5150,
      });

      const startup = yield* detachServe({
        control,
        root: "some-root",
        stateDirectory,
      });

      expect(startup).toEqual({ key: "dumbridge1_secret", pid: 5150 });
      expect(calls.spawns).toEqual(["some-root"]);
      expect(calls.requests).toEqual([{ root: "some-root" }]);
      const text = yield* readRecordText;
      expect(text).not.toContain("dumbridge1_secret");
      const record = JSON.parse(text);
      expect(record.pid).toBe(5150);
      expect(record.root).toBe(resolve("some-root"));
      expect(record.startedAtEpochMs).toBeGreaterThan(0);
    })
  );

  it.effect("forwards the path-forcing reachability to the spawned serve", () =>
    Effect.gen(function* () {
      const { calls, control } = makeControl({});

      yield* detachServe({
        control,
        reachability: "relay-only",
        root: "some-root",
        stateDirectory,
        ttl: "1 hour",
      });

      expect(calls.requests).toEqual([
        { reachability: "relay-only", root: "some-root", ttl: "1 hour" },
      ]);
    })
  );

  it.effect("refuses a record that would land inside the served root", () =>
    Effect.gen(function* () {
      const { calls, control } = makeControl({});

      const error = yield* detachServe({
        control,
        root: join(stateDirectory, ".."),
        stateDirectory,
      }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "DetachedServeError",
        reason: "state-overlap",
      });
      expect(calls.spawns).toEqual([]);
      expect(yield* recordExists).toBe(false);
    })
  );

  it.effect("refuses a dot-dot-prefixed state directory inside the root", () =>
    Effect.gen(function* () {
      const { calls, control } = makeControl({});

      const error = yield* detachServe({
        control,
        root: stateDirectory,
        stateDirectory: join(stateDirectory, "..dumbridge"),
      }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "DetachedServeError",
        reason: "state-overlap",
      });
      expect(calls.spawns).toEqual([]);
    })
  );

  it.effect.skipIf(process.platform === "win32")(
    "refuses an overlap reached through a symlinked root",
    () =>
      Effect.gen(function* () {
        const { calls, control } = makeControl({});
        const linkedRoot = join(stateDirectory, "linked-root");
        yield* Effect.promise(() =>
          symlink(join(stateDirectory, ".."), linkedRoot)
        );

        const error = yield* detachServe({
          control,
          root: linkedRoot,
          stateDirectory,
        }).pipe(Effect.flip);

        expect(error).toMatchObject({
          _tag: "DetachedServeError",
          reason: "state-overlap",
        });
        expect(calls.spawns).toEqual([]);
      })
  );

  it.effect("refuses to start when a detached serve is already running", () =>
    Effect.gen(function* () {
      yield* writeRecord({ pid: 77, root: "/served", startedAtEpochMs: 2000 });
      const { calls, control } = makeControl({
        alivePids: new Set([77]),
        bootTimeMs: 1000,
      });

      const error = yield* detachServe({
        control,
        root: "another-root",
        stateDirectory,
      }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "DetachedServeError",
        reason: "already-running",
      });
      expect(calls.spawns).toEqual([]);
      expect(calls.terminated).toEqual([]);
    })
  );

  it.effect("replaces a record whose process is gone", () =>
    Effect.gen(function* () {
      yield* writeRecord({ pid: 77, root: "/served", startedAtEpochMs: 2000 });
      const { calls, control } = makeControl({
        bootTimeMs: 1000,
        spawnedPid: 88,
      });

      const startup = yield* detachServe({
        control,
        root: "fresh-root",
        stateDirectory,
      });

      expect(startup.pid).toBe(88);
      expect(calls.terminated).toEqual([]);
      expect(JSON.parse(yield* readRecordText).pid).toBe(88);
    })
  );

  it.effect(
    "treats a live pid recorded before the current boot as recycled",
    () =>
      Effect.gen(function* () {
        yield* writeRecord({ pid: 77, root: "/served", startedAtEpochMs: 500 });
        const { calls, control } = makeControl({
          alivePids: new Set([77]),
          bootTimeMs: 100_000,
          spawnedPid: 99,
        });

        const startup = yield* detachServe({
          control,
          root: "fresh-root",
          stateDirectory,
        });

        expect(startup.pid).toBe(99);
        expect(calls.terminated).toEqual([]);
      })
  );

  it.effect("loses a detach race and terminates its own child", () =>
    Effect.gen(function* () {
      const winner = { pid: 300, root: "/served", startedAtEpochMs: 2000 };
      const calls = { spawns: [] as string[], terminated: [] as number[] };
      const control: ServeProcessControl = {
        bootTimeMs: Effect.sync(() => 0),
        isAlive: () => Effect.sync(() => true),
        spawnDetachedServe: ({ root }) =>
          Effect.gen(function* () {
            calls.spawns.push(root);
            yield* writeRecord(winner);
            return { key: "dumbridge1_loser", pid: 301 };
          }),
        terminate: (pid) =>
          Effect.sync(() => {
            calls.terminated.push(pid);
          }),
      };

      const error = yield* detachServe({
        control,
        root: "some-root",
        stateDirectory,
      }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "DetachedServeError",
        reason: "already-running",
      });
      expect(calls.terminated).toEqual([301]);
      expect(JSON.parse(yield* readRecordText).pid).toBe(300);
    })
  );

  it.effect(
    "terminates the fresh child when the record cannot be written",
    () =>
      Effect.gen(function* () {
        const { calls, control } = makeControl({ spawnedPid: 123 });
        const fileBlockingDirectory = join(stateDirectory, "occupied");
        yield* Effect.promise(() =>
          writeFile(fileBlockingDirectory, "not a directory\n")
        );

        const error = yield* detachServe({
          control,
          root: "some-root",
          stateDirectory: fileBlockingDirectory,
        }).pipe(Effect.flip);

        expect(error).toMatchObject({
          _tag: "DetachedServeError",
          reason: "state-io",
        });
        expect(calls.terminated).toEqual([123]);
      })
  );
});

describe("stopDetachedServe", () => {
  it.effect("fails when no detached serve is recorded", () =>
    Effect.gen(function* () {
      const { calls, control } = makeControl({});

      const error = yield* stopDetachedServe({ control, stateDirectory }).pipe(
        Effect.flip
      );

      expect(error).toMatchObject({
        _tag: "DetachedServeError",
        reason: "not-running",
      });
      expect(calls.terminated).toEqual([]);
    })
  );

  it.effect("removes an unreadable record without signaling anything", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => writeFile(recordPath(), "not json"));
      const { calls, control } = makeControl({});

      const result = yield* stopDetachedServe({ control, stateDirectory });

      expect(result).toEqual({ type: "stale-record-removed" });
      expect(calls.terminated).toEqual([]);
      expect(yield* recordExists).toBe(false);
    })
  );

  it.effect("removes a record whose process is gone", () =>
    Effect.gen(function* () {
      yield* writeRecord({ pid: 77, root: "/served", startedAtEpochMs: 2000 });
      const { calls, control } = makeControl({ bootTimeMs: 1000 });

      const result = yield* stopDetachedServe({ control, stateDirectory });

      expect(result).toEqual({ type: "stale-record-removed" });
      expect(calls.terminated).toEqual([]);
      expect(yield* recordExists).toBe(false);
    })
  );

  it.effect("does not signal a live pid recorded before the current boot", () =>
    Effect.gen(function* () {
      yield* writeRecord({ pid: 77, root: "/served", startedAtEpochMs: 500 });
      const { calls, control } = makeControl({
        alivePids: new Set([77]),
        bootTimeMs: 100_000,
      });

      const result = yield* stopDetachedServe({ control, stateDirectory });

      expect(result).toEqual({ type: "stale-record-removed" });
      expect(calls.terminated).toEqual([]);
      expect(yield* recordExists).toBe(false);
    })
  );

  it.effect("terminates a live detached serve and removes the record", () =>
    Effect.gen(function* () {
      yield* writeRecord({ pid: 77, root: "/served", startedAtEpochMs: 2000 });
      const { calls, control } = makeControl({
        alivePids: new Set([77]),
        bootTimeMs: 1000,
      });

      const result = yield* stopDetachedServe({ control, stateDirectory });

      expect(result).toEqual({ pid: 77, type: "stopped" });
      expect(calls.terminated).toEqual([77]);
      expect(yield* recordExists).toBe(false);
    })
  );

  it.effect("does not remove a record replaced while stopping", () =>
    Effect.gen(function* () {
      yield* writeRecord({ pid: 77, root: "/served", startedAtEpochMs: 2000 });
      const alive = new Set([77]);
      const calls = { terminated: [] as number[] };
      const replacement = { pid: 400, root: "/served", startedAtEpochMs: 3000 };
      const control: ServeProcessControl = {
        bootTimeMs: Effect.sync(() => 1000),
        isAlive: (pid) => Effect.sync(() => alive.has(pid)),
        spawnDetachedServe: () =>
          Effect.die("spawning is not used in this test"),
        terminate: (pid) =>
          Effect.gen(function* () {
            calls.terminated.push(pid);
            alive.delete(pid);
            yield* writeRecord(replacement);
          }),
      };

      const result = yield* stopDetachedServe({ control, stateDirectory });

      expect(result).toEqual({ pid: 77, type: "stopped" });
      expect(calls.terminated).toEqual([77]);
      expect(JSON.parse(yield* readRecordText).pid).toBe(400);
    })
  );

  it.effect("keeps the record and fails when the process does not exit", () =>
    Effect.gen(function* () {
      yield* writeRecord({ pid: 77, root: "/served", startedAtEpochMs: 2000 });
      const { calls, control, firstTermination } = makeControl({
        alivePids: new Set([77]),
        bootTimeMs: 1000,
        terminateKills: false,
      });

      const error = yield* Effect.gen(function* () {
        const fiber = yield* stopDetachedServe({
          control,
          stateDirectory,
        }).pipe(Effect.flip, Effect.forkChild);
        yield* Effect.promise(() => firstTermination.promise);
        yield* TestClock.adjust("30 seconds");
        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(TestClock.layer({ warningDelay: "10 seconds" })));

      expect(error).toMatchObject({
        _tag: "DetachedServeError",
        reason: "stop-timeout",
      });
      expect(calls.terminated).toEqual([77]);
      expect(yield* recordExists).toBe(true);
    })
  );

  it.effect("keeps the record when the process cannot be signaled", () =>
    Effect.gen(function* () {
      yield* writeRecord({ pid: 77, root: "/served", startedAtEpochMs: 2000 });
      const { calls, control } = makeControl({
        alivePids: new Set([77]),
        bootTimeMs: 1000,
        terminateFails: true,
      });

      const error = yield* stopDetachedServe({ control, stateDirectory }).pipe(
        Effect.flip
      );

      expect(error).toMatchObject({
        _tag: "DetachedServeError",
        reason: "terminate-failed",
      });
      expect(calls.terminated).toEqual([77]);
      expect(yield* recordExists).toBe(true);
    })
  );
});
