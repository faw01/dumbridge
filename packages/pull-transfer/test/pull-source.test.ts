import { constants, promises as hostFileSystem } from "node:fs";
import {
  chmod,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { describe, expect, it, vi } from "@effect/vitest";
import { Effect, Fiber, Result, Stream } from "effect";
import {
  materializePull,
  PullPathError,
  type PullRead,
  preparePull,
  resolvePullDestination,
} from "../src/index";
import { streamSource, withFixture } from "./support";

describe("pull transfer source", () => {
  it("defaults the destination to the remote basename", () => {
    expect(resolvePullDestination("photos/cat.jpeg")).toEqual(
      Result.succeed("./cat.jpeg")
    );
    expect(
      resolvePullDestination("photos/cat.jpeg", "images/cat.jpeg")
    ).toEqual(Result.succeed("images/cat.jpeg"));
    const rejected = resolvePullDestination("../cat.jpeg", "cat.jpeg");
    expect(Result.isFailure(rejected)).toBe(true);
    expect(
      Result.isFailure(rejected) ? rejected.failure : undefined
    ).toBeInstanceOf(PullPathError);
  });

  it.effect("plans and materializes a deterministic directory", () =>
    withFixture(({ root, servedRoot, workspace }) =>
      Effect.gen(function* () {
        yield* Effect.promise(async () => {
          await mkdir(join(root, "project"), { recursive: true });
          await Promise.all([
            writeFile(join(root, "project", "a.txt"), "alpha"),
            mkdir(join(root, "project", "empty"), { recursive: true }),
            mkdir(join(root, "project", "nested"), { recursive: true }),
          ]);
          await writeFile(
            join(root, "project", "nested", "image.bin"),
            new Uint8Array([0, 1, 2, 255])
          );
        });

        const source = yield* preparePull({
          remotePath: "project",
          servedRoot,
        });

        expect(
          source.manifest.entries.map(({ kind, path }) => [kind, path])
        ).toEqual([
          ["file", "a.txt"],
          ["directory", "empty"],
          ["directory", "nested"],
          ["file", "nested/image.bin"],
        ]);
        expect(source.manifest.totalBytes).toBe(9);

        const destination = join(workspace, "project-copy");
        const result = yield* materializePull({
          destination,
          manifest: source.manifest,
          read: source.read,
        });

        expect(result).toEqual({ bytes: 9, files: 2 });
        expect(
          yield* Effect.promise(() =>
            readFile(join(destination, "a.txt"), "utf8")
          )
        ).toBe("alpha");
        expect(
          new Uint8Array(
            yield* Effect.promise(() =>
              readFile(join(destination, "nested", "image.bin"))
            )
          )
        ).toEqual(new Uint8Array([0, 1, 2, 255]));
        expect(
          yield* Effect.promise(() => readdir(join(destination, "empty")))
        ).toEqual([]);
      })
    )
  );

  it.effect("pulls a live uncommitted file", () =>
    withFixture(({ root, servedRoot, workspace }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          writeFile(join(root, ".env"), "LOCAL_ONLY=yes\n")
        );
        const source = yield* preparePull({ remotePath: ".env", servedRoot });
        const destination = join(workspace, ".env.local");

        yield* materializePull({
          destination,
          manifest: source.manifest,
          read: source.read,
        });

        expect(yield* Effect.promise(() => readFile(destination, "utf8"))).toBe(
          "LOCAL_ONLY=yes\n"
        );
      })
    )
  );

  it.effect("refuses traversal, absolute paths, and separator tricks", () =>
    withFixture(({ servedRoot }) =>
      Effect.gen(function* () {
        const paths = [
          "../secret",
          "/etc/passwd",
          "C:secret",
          "C:\\secret",
          "folder/C:secret",
          "folder/file.txt:stream",
          "folder/CON",
          "folder/CON .txt",
          "folder/CONIN$",
          "folder/conout$.log",
          "folder/AUX .log",
          "folder/com1.txt",
          "folder/name.",
          "folder/name ",
          "folder/has<angle",
          "folder/secret\0.txt",
          "folder\\secret",
          "folder//secret",
          "folder/./secret",
          `folder/${"a".repeat(4096)}`,
        ];

        const errors = yield* Effect.all(
          paths.map((remotePath) =>
            Effect.flip(preparePull({ remotePath, servedRoot })).pipe(
              Effect.map((error) => ({ error, remotePath }))
            )
          ),
          { concurrency: "unbounded" }
        );
        for (const { error, remotePath } of errors) {
          expect(error).toMatchObject({
            _tag: "PullPathError",
            path: remotePath,
          });
        }
      })
    )
  );

  it.effect("refuses symlinks anywhere in the selection", () =>
    withFixture(({ root, servedRoot }) =>
      Effect.gen(function* () {
        const outside = join(root, "outside");
        const selected = join(root, "selected");
        yield* Effect.promise(async () => {
          await Promise.all([
            mkdir(outside, { recursive: true }),
            mkdir(selected, { recursive: true }),
          ]);
          await writeFile(join(outside, "secret.txt"), "secret");
          await symlink(
            outside,
            join(selected, "escape"),
            process.platform === "win32" ? "junction" : "dir"
          );
        });

        const error = yield* Effect.flip(
          preparePull({ remotePath: "selected", servedRoot })
        );

        expect(error).toMatchObject({
          _tag: "PullSymlinkError",
          path: "selected/escape",
        });
      })
    )
  );

  it.effect("refuses a selection below an outside-root ancestor symlink", () =>
    withFixture(({ root, servedRoot }) =>
      Effect.gen(function* () {
        const outside = join(dirname(root), "outside-root");
        const selected = join(root, "selected");
        yield* Effect.promise(async () => {
          await mkdir(outside, { recursive: true });
          await mkdir(selected);
          await writeFile(join(outside, "secret.txt"), "secret");
          await symlink(
            outside,
            join(selected, "escape"),
            process.platform === "win32" ? "junction" : "dir"
          );
        });

        const error = yield* Effect.flip(
          preparePull({
            remotePath: "selected/escape/secret.txt",
            servedRoot,
          })
        );

        expect(error).toMatchObject({
          _tag: "PullSymlinkError",
          path: "selected/escape",
        });
      })
    )
  );

  it.effect("fails when the source changes after planning", () =>
    withFixture(({ root, servedRoot, workspace }) =>
      Effect.gen(function* () {
        const sourcePath = join(root, "draft.txt");
        yield* Effect.promise(() => writeFile(sourcePath, "first"));
        const source = yield* preparePull({
          remotePath: "draft.txt",
          servedRoot,
        });
        yield* Effect.promise(() => writeFile(sourcePath, "other"));

        const error = yield* Effect.flip(
          materializePull({
            destination: join(workspace, "draft.txt"),
            manifest: source.manifest,
            read: source.read,
          })
        );

        expect(error).toMatchObject({
          _tag: "PullSourceChangedError",
          path: "draft.txt",
        });
        expect(yield* Effect.promise(() => readdir(workspace))).toEqual([]);
      })
    )
  );

  it.live.skipIf(process.platform === "win32")(
    "fails promptly when a planned file is replaced by a FIFO",
    () =>
      withFixture(({ root, servedRoot, workspace }) =>
        Effect.gen(function* () {
          const sourcePath = join(root, "draft.txt");
          yield* Effect.promise(() => writeFile(sourcePath, "first"));
          const source = yield* preparePull({
            remotePath: "draft.txt",
            servedRoot,
          });
          const originalOpen = hostFileSystem.open;
          const openCandidate = vi.spyOn(hostFileSystem, "open");
          let swapped = false;
          openCandidate.mockImplementation(async (...args) => {
            if (!swapped && basename(String(args[0])) === "draft.txt") {
              swapped = true;
              await rm(sourcePath);
              const mkfifo = Bun.spawn(["mkfifo", sourcePath], {
                stderr: "pipe",
                stdout: "ignore",
              });
              if ((await mkfifo.exited) !== 0) {
                throw new Error(
                  `mkfifo failed: ${await new Response(mkfifo.stderr).text()}`
                );
              }
            }
            return originalOpen(...args);
          });

          yield* Effect.gen(function* () {
            const transferFiber = yield* Effect.flip(
              materializePull({
                destination: join(workspace, "draft.txt"),
                manifest: source.manifest,
                read: source.read,
              })
            ).pipe(Effect.forkChild);
            const outcome = yield* Effect.race(
              Fiber.join(transferFiber).pipe(
                Effect.map((error) => ({ error, status: "completed" as const }))
              ),
              Effect.sleep("1 second").pipe(
                Effect.map(() => ({ status: "blocked" as const }))
              )
            );

            if (outcome.status === "blocked") {
              // biome-ignore lint/suspicious/noBitwiseOperators: POSIX open flags compose as a bitmask.
              const releaseFlags = constants.O_RDWR | constants.O_NONBLOCK;
              const release = yield* Effect.promise(() =>
                open(sourcePath, releaseFlags)
              );
              yield* Fiber.await(transferFiber).pipe(
                Effect.ensuring(Effect.promise(() => release.close()))
              );
              return yield* Effect.die(
                new Error("pull blocked while opening a replaced FIFO")
              );
            }

            expect(outcome.error).toMatchObject({
              _tag: "ServedRootChangedError",
              message: "served root changed after bridge start",
            });
            expect(yield* Effect.promise(() => readdir(workspace))).toEqual([]);
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                openCandidate.mockRestore();
              })
            )
          );
        })
      )
  );

  it.effect("refuses an intermediate symlink introduced after planning", () =>
    withFixture(({ root, servedRoot, workspace }) =>
      Effect.gen(function* () {
        const sourceDirectory = join(root, "selected", "nested");
        const outside = join(dirname(root), "late-outside-root");
        yield* Effect.promise(async () => {
          await mkdir(sourceDirectory, { recursive: true });
          await mkdir(outside);
          await writeFile(join(sourceDirectory, "file.txt"), "inside");
          await writeFile(join(outside, "file.txt"), "outside");
        });
        const source = yield* preparePull({
          remotePath: "selected/nested/file.txt",
          servedRoot,
        });
        yield* Effect.promise(async () => {
          await rm(sourceDirectory, { recursive: true });
          await symlink(
            outside,
            sourceDirectory,
            process.platform === "win32" ? "junction" : "dir"
          );
        });

        const error = yield* Effect.flip(
          materializePull({
            destination: join(workspace, "file.txt"),
            manifest: source.manifest,
            read: source.read,
          })
        );

        expect(error).toMatchObject({
          _tag: "PullSymlinkError",
          path: "selected/nested",
        });
        expect(yield* Effect.promise(() => readdir(workspace))).toEqual([]);
      })
    )
  );

  it.effect("fails when the source changes during streaming", () =>
    withFixture(({ root, servedRoot, workspace }) =>
      Effect.gen(function* () {
        const sourcePath = join(root, "draft.txt");
        yield* Effect.promise(() => writeFile(sourcePath, "abcdef"));
        const source = yield* preparePull({
          limits: { chunkBytes: 2 },
          remotePath: "draft.txt",
          servedRoot,
        });

        let first = true;
        const readAndMutate: PullRead = (entry, signal) =>
          source.read(entry, signal).pipe(
            Stream.tap(() => {
              if (!first) {
                return Effect.void;
              }
              first = false;
              return Effect.promise(() => writeFile(sourcePath, "ghijkl"));
            })
          );

        const error = yield* Effect.flip(
          materializePull({
            destination: join(workspace, "draft.txt"),
            manifest: source.manifest,
            read: readAndMutate,
          })
        );

        expect(error).toMatchObject({
          _tag: "PullSourceChangedError",
          path: "draft.txt",
        });
        expect(yield* Effect.promise(() => readdir(workspace))).toEqual([]);
      })
    )
  );

  it.effect(
    "fails completion verification when a directory member is added",
    () =>
      withFixture(({ root, servedRoot }) =>
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await mkdir(join(root, "selected"));
            await writeFile(join(root, "selected", "planned.txt"), "planned");
          });
          const source = yield* preparePull({
            remotePath: "selected",
            servedRoot,
          });
          yield* streamSource(source);
          yield* Effect.promise(() =>
            writeFile(join(root, "selected", "added.txt"), "added")
          );

          const error = yield* Effect.flip(source.verify);

          expect(error).toMatchObject({
            _tag: "PullSourceChangedError",
            path: "selected",
          });
        })
      )
  );

  it.effect(
    "fails completion verification when a streamed file is deleted",
    () =>
      withFixture(({ root, servedRoot }) =>
        Effect.gen(function* () {
          const path = join(root, "selected", "planned.txt");
          yield* Effect.promise(async () => {
            await mkdir(join(root, "selected"));
            await writeFile(path, "planned");
          });
          const source = yield* preparePull({
            remotePath: "selected",
            servedRoot,
          });
          yield* streamSource(source);
          yield* Effect.promise(() => rm(path));

          const error = yield* Effect.flip(source.verify);

          expect(error).toMatchObject({
            _tag: "PullSourceChangedError",
            path: "selected",
          });
        })
      )
  );

  it.effect(
    "fails completion verification when a streamed file is replaced",
    () =>
      withFixture(({ root, servedRoot }) =>
        Effect.gen(function* () {
          const path = join(root, "selected", "planned.txt");
          yield* Effect.promise(async () => {
            await mkdir(join(root, "selected"));
            await writeFile(path, "planned");
          });
          const source = yield* preparePull({
            remotePath: "selected",
            servedRoot,
          });
          yield* streamSource(source);
          yield* Effect.promise(async () => {
            await rm(path);
            await writeFile(path, "planned");
          });

          const error = yield* Effect.flip(source.verify);

          expect(error).toMatchObject({
            _tag: "PullSourceChangedError",
          });
        })
      )
  );

  it.effect(
    "fails completion verification when a planned empty directory is removed",
    () =>
      withFixture(({ root, servedRoot }) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            mkdir(join(root, "selected", "empty"), { recursive: true })
          );
          const source = yield* preparePull({
            remotePath: "selected",
            servedRoot,
          });
          yield* streamSource(source);
          yield* Effect.promise(() =>
            rm(join(root, "selected", "empty"), { recursive: true })
          );

          const error = yield* Effect.flip(source.verify);

          expect(error).toMatchObject({
            _tag: "PullSourceChangedError",
            path: "selected",
          });
        })
      )
  );

  it.effect(
    "bounds completion verification when new entries exceed the limit",
    () =>
      withFixture(({ root, servedRoot }) =>
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await mkdir(join(root, "selected"));
            await writeFile(join(root, "selected", "planned.txt"), "planned");
          });
          const source = yield* preparePull({
            limits: { maxEntries: 1 },
            remotePath: "selected",
            servedRoot,
          });
          yield* streamSource(source);
          yield* Effect.promise(() =>
            writeFile(join(root, "selected", "added.txt"), "added")
          );

          const error = yield* Effect.flip(source.verify);

          expect(error).toMatchObject({
            _tag: "PullLimitError",
            limit: "entries",
            maximum: 1,
            observed: 2,
          });
        })
      )
  );

  it.effect("propagates prepare cancellation into source scanning", () =>
    withFixture(({ root, servedRoot }) =>
      Effect.gen(function* () {
        const sourcePath = join(root, "large.bin");
        yield* Effect.promise(async () => {
          await writeFile(sourcePath, "");
          await truncate(sourcePath, 1024 * 1024 * 1024);
        });

        const originalThrowIfAborted = AbortSignal.prototype.throwIfAborted;
        const enoughChecks = Promise.withResolvers<void>();
        const abortObserved = Promise.withResolvers<void>();
        let checks = 0;
        let observedAbort = false;
        function throwIfAborted(this: AbortSignal) {
          checks += 1;
          if (checks >= 5) {
            enoughChecks.resolve();
          }
          observedAbort ||= this.aborted;
          if (observedAbort) {
            abortObserved.resolve();
          }
          return originalThrowIfAborted.call(this);
        }
        Object.defineProperty(AbortSignal.prototype, "throwIfAborted", {
          configurable: true,
          value: throwIfAborted,
          writable: true,
        });

        yield* Effect.gen(function* () {
          const fiber = yield* preparePull({
            remotePath: "large.bin",
            servedRoot,
          }).pipe(Effect.forkChild);
          yield* Effect.promise(() => enoughChecks.promise);
          expect(checks).toBeGreaterThanOrEqual(5);

          yield* Fiber.interrupt(fiber);
          yield* Effect.promise(() => abortObserved.promise);

          expect(observedAbort).toBe(true);
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              Object.defineProperty(AbortSignal.prototype, "throwIfAborted", {
                configurable: true,
                value: originalThrowIfAborted,
                writable: true,
              });
            })
          )
        );
      })
    )
  );

  it.effect(
    "rejects the aggregate byte limit before opening the next file",
    () =>
      withFixture(({ root, servedRoot }) =>
        Effect.gen(function* () {
          const sourcePath = join(root, "too-large.txt");
          yield* Effect.promise(async () => {
            await writeFile(sourcePath, "12");
            if (process.platform !== "win32") {
              await chmod(sourcePath, 0);
            }
          });

          const error = yield* Effect.flip(
            preparePull({
              limits: { maxTotalBytes: 1 },
              remotePath: "too-large.txt",
              servedRoot,
            })
          ).pipe(
            Effect.ensuring(
              process.platform === "win32"
                ? Effect.void
                : Effect.promise(() => chmod(sourcePath, 0o600))
            )
          );

          expect(error).toMatchObject({
            _tag: "PullLimitError",
            limit: "total bytes",
            maximum: 1,
            observed: 2,
          });
        })
      )
  );

  it.effect("rejects a served root that was rebound after bridge start", () =>
    withFixture(({ root, servedRoot }) =>
      Effect.gen(function* () {
        const parkedRoot = `${root}-parked`;
        const outside = join(dirname(root), "outside-rebound-root");
        yield* Effect.promise(async () => {
          await mkdir(outside);
          await writeFile(join(outside, "secret.txt"), "outside secret");
          await rename(root, parkedRoot);
          await symlink(
            outside,
            root,
            process.platform === "win32" ? "junction" : "dir"
          );
        });

        const error = yield* Effect.flip(
          preparePull({ remotePath: "secret.txt", servedRoot })
        );

        expect(error).toMatchObject({ _tag: "ServedRootChangedError" });
      })
    )
  );

  it.effect("enforces manifest entry and byte limits", () =>
    withFixture(({ root, servedRoot }) =>
      Effect.gen(function* () {
        yield* Effect.promise(async () => {
          await mkdir(join(root, "many"), { recursive: true });
          await Promise.all([
            writeFile(join(root, "many", "a"), "12"),
            writeFile(join(root, "many", "b"), "34"),
          ]);
        });

        const entryError = yield* Effect.flip(
          preparePull({
            limits: { maxEntries: 1 },
            remotePath: "many",
            servedRoot,
          })
        );
        expect(entryError).toMatchObject({
          _tag: "PullLimitError",
          limit: "entries",
        });

        const byteError = yield* Effect.flip(
          preparePull({
            limits: { maxTotalBytes: 3 },
            remotePath: "many",
            servedRoot,
          })
        );
        expect(byteError).toMatchObject({
          _tag: "PullLimitError",
          limit: "total bytes",
        });
      })
    )
  );
});
