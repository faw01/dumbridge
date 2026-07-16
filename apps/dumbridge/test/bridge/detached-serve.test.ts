import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import {
  DetachedServeError,
  type DetachedServeRecord,
  type DetachedSpawnRequest,
  detachServe,
  listDetachedServes,
  type ServeProcessControl,
  stopDetachedServe,
} from "../../src/bridge/detached-serve";

let stateDirectory = "";

// The fixture is realpath'd so the absolute roots built from it are already
// canonical and can be compared literally against persisted roots.
beforeEach(async () => {
  stateDirectory = await realpath(
    await mkdtemp(join(tmpdir(), "dumbridge-detach-"))
  );
});

afterEach(async () => {
  await rm(stateDirectory, { force: true, recursive: true });
});

const rootPath = (name: string) => join(stateDirectory, name);

// The tests never derive hashed record file names themselves: records are
// seeded through detachServe and inspected by reading whatever the state
// directory holds, so they survive changes to the on-disk naming scheme. The
// one literal name is `detached-serve.json`, the compatibility contract with
// records written before they were keyed by root.
const legacyRecordFileName = "detached-serve.json";

const recordTexts = Effect.promise(async (): Promise<readonly string[]> => {
  let names: readonly string[];
  try {
    names = (await readdir(stateDirectory)).sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
  return await Promise.all(
    names
      .filter((name) => name.startsWith("detached-serve"))
      .map((name) => readFile(join(stateDirectory, name), "utf8"))
  );
});

const storedPids = Effect.map(recordTexts, (texts) =>
  texts.map((text) => JSON.parse(text).pid as number).sort((a, b) => a - b)
);

const corruptStoredRecords = Effect.promise(async () => {
  const names = await readdir(stateDirectory);
  await Promise.all(
    names
      .filter((name) => name.startsWith("detached-serve"))
      .map((name) => writeFile(join(stateDirectory, name), "not json"))
  );
});

const writeLegacyRecord = (record: {
  readonly pid: number;
  readonly root: string;
  readonly startedAtEpochMs: number;
}) =>
  Effect.promise(() =>
    writeFile(
      join(stateDirectory, legacyRecordFileName),
      JSON.stringify(record)
    )
  );

const makeControl = (overrides: {
  readonly alivePids?: ReadonlySet<number>;
  readonly bootTimeMs?: number;
  readonly spawnedExpiresAtIso?: string;
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
        return {
          key: overrides.spawnedKey ?? "dumbridge1_test",
          pid,
          ...(overrides.spawnedExpiresAtIso === undefined
            ? {}
            : { expiresAtIso: overrides.spawnedExpiresAtIso }),
        };
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

const seedDetachedServe = (root: string, pid: number) =>
  Effect.suspend(() => {
    const seeded = makeControl({ spawnedPid: pid });
    return detachServe({ control: seeded.control, root, stateDirectory });
  });

describe("detachServe", () => {
  it.effect("spawns a detached serve and records it without the key", () =>
    Effect.gen(function* () {
      const { calls, control } = makeControl({
        spawnedKey: "dumbridge1_secret",
        spawnedPid: 5150,
      });

      const startup = yield* detachServe({
        control,
        root: rootPath("some-root"),
        stateDirectory,
      });

      expect(startup).toEqual({ key: "dumbridge1_secret", pid: 5150 });
      expect(calls.spawns).toEqual([rootPath("some-root")]);
      expect(calls.requests).toEqual([{ root: rootPath("some-root") }]);
      const [text] = yield* recordTexts;
      expect(text).toBeDefined();
      expect(text).not.toContain("dumbridge1_secret");
      const record = JSON.parse(text ?? "");
      expect(record.pid).toBe(5150);
      expect(record.root).toBe(rootPath("some-root"));
      expect(record.startedAtEpochMs).toBeGreaterThan(0);
      expect(record).not.toHaveProperty("expiresAtEpochMs");
    })
  );

  it.effect("persists the key expiry captured at startup", () =>
    Effect.gen(function* () {
      const { control } = makeControl({
        spawnedExpiresAtIso: "2026-01-01T00:00:00.000Z",
      });

      yield* detachServe({
        control,
        root: rootPath("some-root"),
        stateDirectory,
      });

      const [text] = yield* recordTexts;
      expect(JSON.parse(text ?? "").expiresAtEpochMs).toBe(1_767_225_600_000);
    })
  );

  it.effect("forwards the path-forcing reachability to the spawned serve", () =>
    Effect.gen(function* () {
      const { calls, control } = makeControl({});

      yield* detachServe({
        control,
        reachability: "relay-only",
        root: rootPath("some-root"),
        stateDirectory,
        ttl: "1 hour",
      });

      expect(calls.requests).toEqual([
        {
          reachability: "relay-only",
          root: rootPath("some-root"),
          ttl: "1 hour",
        },
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
      expect(yield* recordTexts).toEqual([]);
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

  it.effect("serves two different roots at the same time", () =>
    Effect.gen(function* () {
      const first = makeControl({ spawnedPid: 111 });
      const second = makeControl({ spawnedPid: 222 });

      yield* detachServe({
        control: first.control,
        root: rootPath("root-a"),
        stateDirectory,
      });
      const startup = yield* detachServe({
        control: second.control,
        root: rootPath("root-b"),
        stateDirectory,
      });

      expect(startup.pid).toBe(222);
      expect(second.calls.spawns).toEqual([rootPath("root-b")]);
      expect(yield* storedPids).toEqual([111, 222]);
    })
  );

  it.effect("refuses a second detach of an already-served root", () =>
    Effect.gen(function* () {
      yield* seedDetachedServe(rootPath("same-root"), 77);
      const { calls, control } = makeControl({ alivePids: new Set([77]) });

      const error = yield* detachServe({
        control,
        root: rootPath("same-root"),
        stateDirectory,
      }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "DetachedServeError",
        message: `A detached serve is already running for ${rootPath("same-root")}. Stop it with dumbridge serve --stop ${rootPath("same-root")}.`,
        reason: "already-running",
      });
      expect(calls.spawns).toEqual([]);
      expect(calls.terminated).toEqual([]);
    })
  );

  it.effect.skipIf(process.platform === "win32")(
    "refuses a second detach of the same root reached through a symlink",
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() => mkdir(rootPath("real-root")));
        yield* Effect.promise(() =>
          symlink(rootPath("real-root"), rootPath("alias-root"))
        );
        yield* seedDetachedServe(rootPath("real-root"), 77);
        const { calls, control } = makeControl({ alivePids: new Set([77]) });

        const error = yield* detachServe({
          control,
          root: rootPath("alias-root"),
          stateDirectory,
        }).pipe(Effect.flip);

        expect(error).toMatchObject({
          _tag: "DetachedServeError",
          message: `A detached serve is already running for ${rootPath("real-root")}. Stop it with dumbridge serve --stop ${rootPath("real-root")}.`,
          reason: "already-running",
        });
        expect(calls.spawns).toEqual([]);
      })
  );

  it.effect.skipIf(process.platform === "win32")(
    "spawns the canonical root when detached through a symlink",
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() => mkdir(rootPath("real-root")));
        yield* Effect.promise(() =>
          symlink(rootPath("real-root"), rootPath("alias-root"))
        );
        const { calls, control } = makeControl({ spawnedPid: 55 });

        yield* detachServe({
          control,
          root: rootPath("alias-root"),
          stateDirectory,
        });

        expect(calls.spawns).toEqual([rootPath("real-root")]);
        const [text] = yield* recordTexts;
        expect(JSON.parse(text ?? "").root).toBe(rootPath("real-root"));
      })
  );

  it.effect("refuses a root already served by a pre-upgrade record", () =>
    Effect.gen(function* () {
      yield* writeLegacyRecord({
        pid: 77,
        root: rootPath("legacy-root"),
        startedAtEpochMs: Date.now(),
      });
      const { calls, control } = makeControl({ alivePids: new Set([77]) });

      const error = yield* detachServe({
        control,
        root: rootPath("legacy-root"),
        stateDirectory,
      }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "DetachedServeError",
        reason: "already-running",
      });
      expect(calls.spawns).toEqual([]);
    })
  );

  it.effect("replaces a record whose process is gone", () =>
    Effect.gen(function* () {
      yield* seedDetachedServe(rootPath("fresh-root"), 77);
      const { calls, control } = makeControl({ spawnedPid: 88 });

      const startup = yield* detachServe({
        control,
        root: rootPath("fresh-root"),
        stateDirectory,
      });

      expect(startup.pid).toBe(88);
      expect(calls.terminated).toEqual([]);
      expect(yield* storedPids).toEqual([88]);
    })
  );

  it.effect(
    "treats a live pid recorded before the current boot as recycled",
    () =>
      Effect.gen(function* () {
        yield* seedDetachedServe(rootPath("fresh-root"), 77);
        const { calls, control } = makeControl({
          alivePids: new Set([77]),
          bootTimeMs: Date.now() + 86_400_000,
          spawnedPid: 99,
        });

        const startup = yield* detachServe({
          control,
          root: rootPath("fresh-root"),
          stateDirectory,
        });

        expect(startup.pid).toBe(99);
        expect(calls.terminated).toEqual([]);
      })
  );

  it.effect("loses a detach race and terminates its own child", () =>
    Effect.gen(function* () {
      const winner = makeControl({ spawnedPid: 300 });
      const calls = { spawns: [] as string[], terminated: [] as number[] };
      const control: ServeProcessControl = {
        bootTimeMs: Effect.sync(() => 0),
        isAlive: () => Effect.sync(() => true),
        spawnDetachedServe: ({ root }) =>
          Effect.gen(function* () {
            calls.spawns.push(root);
            yield* detachServe({
              control: winner.control,
              root,
              stateDirectory,
            });
            return { key: "dumbridge1_loser", pid: 301 };
          }),
        terminate: (pid) =>
          Effect.sync(() => {
            calls.terminated.push(pid);
          }),
      };

      const error = yield* detachServe({
        control,
        root: rootPath("some-root"),
        stateDirectory,
      }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "DetachedServeError",
        reason: "already-running",
      });
      expect(error.message).toContain(rootPath("some-root"));
      expect(calls.terminated).toEqual([301]);
      expect(yield* storedPids).toEqual([300]);
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
          root: rootPath("some-root"),
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

describe("listDetachedServes", () => {
  it.effect(
    "lists live serves by root, prunes stale records, and leaves foreign files",
    () =>
      Effect.gen(function* () {
        yield* seedDetachedServe(rootPath("root-b"), 222);
        yield* seedDetachedServe(rootPath("root-a"), 111);
        yield* seedDetachedServe(rootPath("root-c"), 333);
        yield* Effect.promise(() =>
          writeFile(join(stateDirectory, "notes.txt"), "not a record")
        );
        const { control } = makeControl({ alivePids: new Set([111, 222]) });

        const records: readonly DetachedServeRecord[] =
          yield* listDetachedServes({ control, stateDirectory });

        expect(
          records.map((record) => ({ pid: record.pid, root: record.root }))
        ).toEqual([
          { pid: 111, root: rootPath("root-a") },
          { pid: 222, root: rootPath("root-b") },
        ]);
        expect(yield* storedPids).toEqual([111, 222]);
        expect(
          yield* Effect.promise(() =>
            readFile(join(stateDirectory, "notes.txt"), "utf8")
          )
        ).toBe("not a record");
      })
  );

  it.effect("prunes a live-pid record written before the current boot", () =>
    Effect.gen(function* () {
      yield* seedDetachedServe(rootPath("pre-boot-root"), 77);
      const { control } = makeControl({
        alivePids: new Set([77]),
        bootTimeMs: Date.now() + 86_400_000,
      });

      const records = yield* listDetachedServes({ control, stateDirectory });

      expect(records).toEqual([]);
      expect(yield* recordTexts).toEqual([]);
    })
  );

  it.effect("prunes an unreadable record while listing", () =>
    Effect.gen(function* () {
      yield* seedDetachedServe(rootPath("served"), 77);
      yield* corruptStoredRecords;
      const { control } = makeControl({});

      const records = yield* listDetachedServes({ control, stateDirectory });

      expect(records).toEqual([]);
      expect(yield* recordTexts).toEqual([]);
    })
  );

  it.effect(
    "treats a record whose timestamp no Date can represent as unreadable",
    () =>
      Effect.gen(function* () {
        // One millisecond past the JavaScript Date range: a status surface
        // could not render it, so the record must decode as unreadable and
        // be reclaimed rather than poison the whole listing.
        yield* writeLegacyRecord({
          pid: 77,
          root: rootPath("served"),
          startedAtEpochMs: 8_640_000_000_000_001,
        });
        const { control } = makeControl({ alivePids: new Set([77]) });

        const records = yield* listDetachedServes({ control, stateDirectory });

        expect(records).toEqual([]);
        expect(yield* recordTexts).toEqual([]);
      })
  );

  it.effect("lists a live serve recorded before the upgrade", () =>
    Effect.gen(function* () {
      yield* writeLegacyRecord({
        pid: 77,
        root: rootPath("legacy-root"),
        startedAtEpochMs: Date.now(),
      });
      const { control } = makeControl({ alivePids: new Set([77]) });

      const records = yield* listDetachedServes({ control, stateDirectory });

      expect(
        records.map((record) => ({ pid: record.pid, root: record.root }))
      ).toEqual([{ pid: 77, root: rootPath("legacy-root") }]);
    })
  );

  it.effect("lists nothing when the state directory does not exist", () =>
    Effect.gen(function* () {
      const { control } = makeControl({});

      const records = yield* listDetachedServes({
        control,
        stateDirectory: join(stateDirectory, "missing"),
      });

      expect(records).toEqual([]);
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
      yield* seedDetachedServe(rootPath("served"), 77);
      yield* corruptStoredRecords;
      const { calls, control } = makeControl({});

      const result = yield* stopDetachedServe({ control, stateDirectory });

      expect(result).toEqual({ type: "stale-record-removed" });
      expect(calls.terminated).toEqual([]);
      expect(yield* recordTexts).toEqual([]);
    })
  );

  it.effect("removes a record whose process is gone", () =>
    Effect.gen(function* () {
      yield* seedDetachedServe(rootPath("served"), 77);
      const { calls, control } = makeControl({});

      const result = yield* stopDetachedServe({ control, stateDirectory });

      expect(result).toEqual({ type: "stale-record-removed" });
      expect(calls.terminated).toEqual([]);
      expect(yield* recordTexts).toEqual([]);
    })
  );

  it.effect("does not signal a live pid recorded before the current boot", () =>
    Effect.gen(function* () {
      yield* seedDetachedServe(rootPath("served"), 77);
      const { calls, control } = makeControl({
        alivePids: new Set([77]),
        bootTimeMs: Date.now() + 86_400_000,
      });

      const result = yield* stopDetachedServe({ control, stateDirectory });

      expect(result).toEqual({ type: "stale-record-removed" });
      expect(calls.terminated).toEqual([]);
      expect(yield* recordTexts).toEqual([]);
    })
  );

  it.effect("terminates a live detached serve and removes the record", () =>
    Effect.gen(function* () {
      yield* seedDetachedServe(rootPath("served"), 77);
      const { calls, control } = makeControl({ alivePids: new Set([77]) });

      const result = yield* stopDetachedServe({ control, stateDirectory });

      expect(result).toEqual({ pid: 77, type: "stopped" });
      expect(calls.terminated).toEqual([77]);
      expect(yield* recordTexts).toEqual([]);
    })
  );

  it.effect("stops only the serve for the given root", () =>
    Effect.gen(function* () {
      yield* seedDetachedServe(rootPath("root-a"), 111);
      yield* seedDetachedServe(rootPath("root-b"), 222);
      const { calls, control } = makeControl({
        alivePids: new Set([111, 222]),
      });

      const result = yield* stopDetachedServe({
        control,
        root: rootPath("root-a"),
        stateDirectory,
      });

      expect(result).toEqual({ pid: 111, type: "stopped" });
      expect(calls.terminated).toEqual([111]);
      expect(yield* storedPids).toEqual([222]);
    })
  );

  it.effect.skipIf(process.platform === "win32")(
    "stops a serve selected through a symlink to its root",
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() => mkdir(rootPath("real-root")));
        yield* Effect.promise(() =>
          symlink(rootPath("real-root"), rootPath("alias-root"))
        );
        yield* seedDetachedServe(rootPath("real-root"), 77);
        const { calls, control } = makeControl({ alivePids: new Set([77]) });

        const result = yield* stopDetachedServe({
          control,
          root: rootPath("alias-root"),
          stateDirectory,
        });

        expect(result).toEqual({ pid: 77, type: "stopped" });
        expect(calls.terminated).toEqual([77]);
        expect(yield* recordTexts).toEqual([]);
      })
  );

  it.effect.skipIf(process.platform === "win32")(
    "selects a pre-upgrade record through its symlink spelling",
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() => mkdir(rootPath("real-root")));
        yield* Effect.promise(() =>
          symlink(rootPath("real-root"), rootPath("alias-root"))
        );
        // A pre-upgrade release resolved but did not realpath the root, so
        // its record can carry the symlink spelling.
        yield* writeLegacyRecord({
          pid: 77,
          root: rootPath("alias-root"),
          startedAtEpochMs: Date.now(),
        });
        const { calls, control } = makeControl({ alivePids: new Set([77]) });

        const result = yield* stopDetachedServe({
          control,
          root: rootPath("real-root"),
          stateDirectory,
        });

        expect(result).toEqual({ pid: 77, type: "stopped" });
        expect(calls.terminated).toEqual([77]);
        expect(yield* recordTexts).toEqual([]);
      })
  );

  it.effect("stops a live serve recorded before the upgrade", () =>
    Effect.gen(function* () {
      yield* writeLegacyRecord({
        pid: 77,
        root: rootPath("legacy-root"),
        startedAtEpochMs: Date.now(),
      });
      const { calls, control } = makeControl({ alivePids: new Set([77]) });

      const result = yield* stopDetachedServe({ control, stateDirectory });

      expect(result).toEqual({ pid: 77, type: "stopped" });
      expect(calls.terminated).toEqual([77]);
      expect(yield* recordTexts).toEqual([]);
    })
  );

  it.effect(
    "reclaims an unreadable pre-upgrade record on a selected stop",
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          writeFile(join(stateDirectory, legacyRecordFileName), "not json")
        );
        const { calls, control } = makeControl({});

        const result = yield* stopDetachedServe({
          control,
          root: rootPath("any-root"),
          stateDirectory,
        });

        expect(result).toEqual({ type: "stale-record-removed" });
        expect(calls.terminated).toEqual([]);
        expect(yield* recordTexts).toEqual([]);
      })
  );

  it.effect("fails when the given root has no detached serve", () =>
    Effect.gen(function* () {
      yield* seedDetachedServe(rootPath("root-a"), 111);
      const { calls, control } = makeControl({ alivePids: new Set([111]) });

      const error = yield* stopDetachedServe({
        control,
        root: rootPath("root-b"),
        stateDirectory,
      }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "DetachedServeError",
        message: `No detached serve is running for ${rootPath("root-b")}.`,
        reason: "not-running",
      });
      expect(calls.terminated).toEqual([]);
      expect(yield* storedPids).toEqual([111]);
    })
  );

  it.effect("refuses an unselected stop while several serves run", () =>
    Effect.gen(function* () {
      yield* seedDetachedServe(rootPath("root-a"), 111);
      yield* seedDetachedServe(rootPath("root-b"), 222);
      const { calls, control } = makeControl({
        alivePids: new Set([111, 222]),
      });

      const error = yield* stopDetachedServe({ control, stateDirectory }).pipe(
        Effect.flip
      );

      expect(error).toMatchObject({
        _tag: "DetachedServeError",
        message: `Multiple detached serves are running (${rootPath("root-a")}, ${rootPath("root-b")}). Stop one with dumbridge serve --stop <root>.`,
        reason: "multiple-running",
      });
      expect(calls.terminated).toEqual([]);
      expect(yield* storedPids).toEqual([111, 222]);
    })
  );

  it.effect(
    "reclaims stale records and stops the one remaining live serve",
    () =>
      Effect.gen(function* () {
        yield* seedDetachedServe(rootPath("root-a"), 111);
        yield* seedDetachedServe(rootPath("root-b"), 222);
        const { calls, control } = makeControl({ alivePids: new Set([222]) });

        const result = yield* stopDetachedServe({ control, stateDirectory });

        expect(result).toEqual({ pid: 222, type: "stopped" });
        expect(calls.terminated).toEqual([222]);
        expect(yield* recordTexts).toEqual([]);
      })
  );

  it.effect("does not remove a record replaced while stopping", () =>
    Effect.gen(function* () {
      yield* seedDetachedServe(rootPath("served"), 77);
      const replacer = makeControl({ spawnedPid: 400 });
      const alive = new Set([77]);
      const calls = { terminated: [] as number[] };
      const control: ServeProcessControl = {
        bootTimeMs: Effect.sync(() => 0),
        isAlive: (pid) => Effect.sync(() => alive.has(pid)),
        spawnDetachedServe: () =>
          Effect.die("spawning is not used in this test"),
        terminate: (pid) =>
          Effect.gen(function* () {
            calls.terminated.push(pid);
            alive.delete(pid);
            yield* detachServe({
              control: replacer.control,
              root: rootPath("served"),
              stateDirectory,
            });
          }),
      };

      const result = yield* stopDetachedServe({ control, stateDirectory });

      expect(result).toEqual({ pid: 77, type: "stopped" });
      expect(calls.terminated).toEqual([77]);
      expect(yield* storedPids).toEqual([400]);
    })
  );

  it.effect("keeps the record and fails when the process does not exit", () =>
    Effect.gen(function* () {
      yield* seedDetachedServe(rootPath("served"), 77);
      const { calls, control, firstTermination } = makeControl({
        alivePids: new Set([77]),
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
      expect((yield* recordTexts).length).toBe(1);
    })
  );

  it.effect("keeps the record when the process cannot be signaled", () =>
    Effect.gen(function* () {
      yield* seedDetachedServe(rootPath("served"), 77);
      const { calls, control } = makeControl({
        alivePids: new Set([77]),
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
      expect((yield* recordTexts).length).toBe(1);
    })
  );
});
