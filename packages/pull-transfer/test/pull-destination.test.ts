import { promises as hostFileSystem } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { describe, expect, it, vi } from "@effect/vitest";
import { Effect, Fiber, Stream } from "effect";
import {
  materializePull,
  type PullFileEntry,
  type PullManifest,
  type PullRead,
  preparePull,
} from "../src/index";
import { oneChunk, pathExists, withFixture } from "./support";

describe("pull transfer destination", () => {
  it.effect("verifies received bytes before exposing the destination", () =>
    withFixture(({ root, servedRoot, workspace }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          writeFile(join(root, "cat.jpeg"), new Uint8Array([1, 2, 3]))
        );
        const source = yield* preparePull({
          remotePath: "cat.jpeg",
          servedRoot,
        });

        const error = yield* Effect.flip(
          materializePull({
            destination: join(workspace, "cat.jpeg"),
            manifest: source.manifest,
            read: () => oneChunk(new Uint8Array([3, 2, 1])),
          })
        );

        expect(error).toMatchObject({
          _tag: "PullIntegrityError",
          path: "cat.jpeg",
        });
        expect(yield* Effect.promise(() => readdir(workspace))).toEqual([]);
      })
    )
  );

  it.effect("rejects reader chunks above the receiver limit", () =>
    withFixture(({ root, servedRoot, workspace }) =>
      Effect.gen(function* () {
        const bytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
        yield* Effect.promise(() =>
          writeFile(join(root, "large-frame.bin"), bytes)
        );
        const source = yield* preparePull({
          remotePath: "large-frame.bin",
          servedRoot,
        });

        const error = yield* Effect.flip(
          materializePull({
            destination: join(workspace, "large-frame.bin"),
            limits: { chunkBytes: 4 },
            manifest: source.manifest,
            read: () => oneChunk(bytes),
          })
        );

        expect(error).toMatchObject({
          _tag: "PullLimitError",
          limit: "chunk bytes",
          maximum: 4,
          observed: 8,
        });
        expect(yield* Effect.promise(() => readdir(workspace))).toEqual([]);
      })
    )
  );

  it.effect("removes new parent directories after a reader failure", () =>
    withFixture(({ root, servedRoot, workspace }) =>
      Effect.gen(function* () {
        const existingParent = join(workspace, "existing");
        yield* Effect.promise(async () => {
          await writeFile(join(root, "broken.txt"), "broken");
          await mkdir(existingParent);
          await writeFile(join(existingParent, "keep.txt"), "keep");
        });
        const source = yield* preparePull({
          remotePath: "broken.txt",
          servedRoot,
        });

        const error = yield* Effect.flip(
          materializePull({
            destination: join(existingParent, "new", "deep", "broken.txt"),
            manifest: source.manifest,
            read: () => {
              throw new Error("reader failed");
            },
          })
        );

        expect(error).toMatchObject({
          _tag: "PullIOError",
          operation: "open pull stream",
          path: "broken.txt",
        });
        expect(yield* Effect.promise(() => readdir(workspace))).toEqual([
          "existing",
        ]);
        expect(yield* Effect.promise(() => readdir(existingParent))).toEqual([
          "keep.txt",
        ]);
        expect(
          yield* Effect.promise(() =>
            readFile(join(existingParent, "keep.txt"), "utf8")
          )
        ).toBe("keep");
      })
    )
  );

  it.effect("maps a reader failure and removes its staging directory", () =>
    withFixture(({ root, servedRoot, workspace }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          writeFile(join(root, "broken.txt"), "broken")
        );
        const source = yield* preparePull({
          remotePath: "broken.txt",
          servedRoot,
        });

        const error = yield* Effect.flip(
          materializePull({
            destination: join(workspace, "broken.txt"),
            manifest: source.manifest,
            read: () => {
              throw new Error("reader failed");
            },
          })
        );

        expect(error).toMatchObject({
          _tag: "PullIOError",
          operation: "open pull stream",
          path: "broken.txt",
        });
        expect(yield* Effect.promise(() => readdir(workspace))).toEqual([]);
      })
    )
  );

  it.live("interrupts a stalled reader and removes its staging directory", () =>
    withFixture(({ root, servedRoot, workspace }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          writeFile(join(root, "stalled.txt"), "stalled")
        );
        const source = yield* preparePull({
          remotePath: "stalled.txt",
          servedRoot,
        });
        let readerSignal: AbortSignal | undefined;
        const started = Promise.withResolvers<void>();
        const stalledRead = (_entry: PullFileEntry, signal: AbortSignal) => {
          readerSignal = signal;
          started.resolve();
          return Stream.never;
        };
        const fiber = yield* materializePull({
          destination: join(workspace, "stalled.txt"),
          manifest: source.manifest,
          read: stalledRead,
        }).pipe(Effect.forkChild);

        yield* Effect.promise(() => started.promise);
        yield* Fiber.interrupt(fiber).pipe(Effect.timeout("1 second"));

        expect(readerSignal?.aborted).toBe(true);
        expect(yield* Effect.promise(() => readdir(workspace))).toEqual([]);
      })
    )
  );

  it.effect("refuses an existing destination", () =>
    withFixture(({ root, servedRoot, workspace }) =>
      Effect.gen(function* () {
        const destination = join(workspace, "file.txt");
        yield* Effect.promise(async () => {
          await writeFile(join(root, "file.txt"), "new");
          await writeFile(destination, "keep");
        });
        const source = yield* preparePull({
          remotePath: "file.txt",
          servedRoot,
        });

        const error = yield* Effect.flip(
          materializePull({
            destination,
            manifest: source.manifest,
            read: source.read,
          })
        );

        expect(error).toMatchObject({ _tag: "PullDestinationExistsError" });
        expect(yield* Effect.promise(() => readFile(destination, "utf8"))).toBe(
          "keep"
        );
      })
    )
  );

  it.effect("never replaces a file created while bytes are staged", () =>
    withFixture(({ root, servedRoot, workspace }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          writeFile(join(root, "file.txt"), "incoming")
        );
        const source = yield* preparePull({
          remotePath: "file.txt",
          servedRoot,
        });
        const destination = join(workspace, "file.txt");
        let destinationCreated = false;
        const racingRead: PullRead = (entry, signal) =>
          source.read(entry, signal).pipe(
            Stream.tap(() => {
              if (destinationCreated) {
                return Effect.void;
              }
              destinationCreated = true;
              return Effect.promise(() => writeFile(destination, "keep"));
            })
          );

        const error = yield* Effect.flip(
          materializePull({
            destination,
            manifest: source.manifest,
            read: racingRead,
          })
        );

        expect(error).toMatchObject({ _tag: "PullDestinationExistsError" });
        expect(yield* Effect.promise(() => readFile(destination, "utf8"))).toBe(
          "keep"
        );
        expect(yield* Effect.promise(() => readdir(workspace))).toEqual([
          "file.txt",
        ]);
      })
    )
  );

  it.effect("exposes a verified directory in one commit", () =>
    withFixture(({ root, servedRoot, workspace }) =>
      Effect.gen(function* () {
        yield* Effect.promise(async () => {
          await mkdir(join(root, "folder"));
          await Promise.all([
            writeFile(join(root, "folder", "a.txt"), "alpha"),
            writeFile(join(root, "folder", "b.txt"), "beta"),
          ]);
        });
        const source = yield* preparePull({
          remotePath: "folder",
          servedRoot,
        });
        const destination = join(workspace, "folder");
        const mayRead = Promise.withResolvers<void>();
        const started = Promise.withResolvers<void>();
        const gatedRead: PullRead = (entry, signal) =>
          Stream.unwrap(
            Effect.promise(async () => {
              started.resolve();
              await mayRead.promise;
              return source.read(entry, signal);
            })
          );
        const fiber = yield* materializePull({
          destination,
          manifest: source.manifest,
          read: gatedRead,
        }).pipe(Effect.forkChild);

        yield* Effect.promise(() => started.promise);
        try {
          expect(yield* Effect.promise(() => pathExists(destination))).toBe(
            false
          );
        } finally {
          mayRead.resolve();
        }
        yield* Fiber.join(fiber);

        expect(
          (yield* Effect.promise(() => readdir(destination))).sort()
        ).toEqual(["a.txt", "b.txt"]);
        expect(
          yield* Effect.promise(() =>
            readFile(join(destination, "a.txt"), "utf8")
          )
        ).toBe("alpha");
        expect(
          yield* Effect.promise(() =>
            readFile(join(destination, "b.txt"), "utf8")
          )
        ).toBe("beta");
      })
    )
  );

  it.effect(
    "keeps a published pull successful when staging cleanup fails",
    () =>
      withFixture(({ root, servedRoot, workspace }) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            writeFile(join(root, "published.txt"), "published")
          );
          const source = yield* preparePull({
            remotePath: "published.txt",
            servedRoot,
          });
          const destination = join(workspace, "published.txt");
          const remove = hostFileSystem.rm;
          const removeSpy = vi.spyOn(hostFileSystem, "rm");
          removeSpy.mockImplementation(async (path, options) => {
            if (
              basename(String(path)).startsWith(".dumbridge-pull-") &&
              (await pathExists(destination))
            ) {
              throw Object.assign(new Error("staging cleanup failed"), {
                code: "EACCES",
              });
            }
            return remove(path, options);
          });

          const result = yield* materializePull({
            destination,
            manifest: source.manifest,
            read: source.read,
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                removeSpy.mockRestore();
              })
            )
          );

          expect(result).toEqual({ bytes: 9, files: 1 });
          expect(
            yield* Effect.promise(() => readFile(destination, "utf8"))
          ).toBe("published");
          const stages = (yield* Effect.promise(() =>
            readdir(workspace)
          )).filter((name) => name.startsWith(".dumbridge-pull-"));
          expect(stages).toHaveLength(1);
          const [stage] = stages;
          if (stage === undefined) {
            throw new Error("the failed cleanup did not leave its stage");
          }
          expect(
            yield* Effect.promise(() => readdir(join(workspace, stage)))
          ).toEqual([]);
        })
      )
  );

  it.effect("never replaces a directory created while bytes are staged", () =>
    withFixture(({ root, servedRoot, workspace }) =>
      Effect.gen(function* () {
        yield* Effect.promise(async () => {
          await mkdir(join(root, "folder"));
          await writeFile(join(root, "folder", "file.txt"), "new");
        });
        const source = yield* preparePull({
          remotePath: "folder",
          servedRoot,
        });
        const destination = join(workspace, "folder");
        let destinationCreated = false;
        const racingRead: PullRead = (entry, signal) =>
          Stream.unwrap(
            Effect.promise(async () => {
              if (!destinationCreated) {
                destinationCreated = true;
                await mkdir(destination);
              }
              return source.read(entry, signal);
            })
          );

        const error = yield* Effect.flip(
          materializePull({
            destination,
            manifest: source.manifest,
            read: racingRead,
          })
        );

        expect(error).toMatchObject({ _tag: "PullDestinationExistsError" });
        expect(yield* Effect.promise(() => readdir(destination))).toEqual([]);
        expect(yield* Effect.promise(() => readdir(workspace))).toEqual([
          "folder",
        ]);
      })
    )
  );

  it.effect("rejects a malicious manifest path before writing", () =>
    withFixture(({ workspace }) =>
      Effect.gen(function* () {
        const manifest: PullManifest = {
          digestAlgorithm: "sha256",
          entries: [
            {
              digest:
                "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
              kind: "file",
              path: "../escape",
              size: 0,
            },
          ],
          kind: "directory",
          name: "files",
          totalBytes: 0,
        };

        const error = yield* Effect.flip(
          materializePull({
            destination: join(workspace, "files"),
            manifest,
            read: () => oneChunk(new Uint8Array()),
          })
        );

        expect(error).toMatchObject({
          _tag: "PullPathError",
          path: "../escape",
        });
        expect(yield* Effect.promise(() => readdir(workspace))).toEqual([]);
      })
    )
  );

  it.effect(
    "rejects Windows device aliases in received manifest components",
    () =>
      withFixture(({ workspace }) =>
        Effect.gen(function* () {
          const aliases = ["CONIN$", "conout$.txt", "CON .txt", "AUX .log"];

          // Sequential on purpose: each alias must be rejected independently.
          yield* Effect.forEach(aliases, (alias) => {
            const manifest: PullManifest = {
              digestAlgorithm: "sha256",
              entries: [
                { kind: "directory", path: "safe" },
                {
                  digest:
                    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
                  kind: "file",
                  path: `safe/${alias}`,
                  size: 0,
                },
              ],
              kind: "directory",
              name: "files",
              totalBytes: 0,
            };

            return Effect.flip(
              materializePull({
                destination: join(workspace, alias),
                manifest,
                read: () => oneChunk(new Uint8Array()),
              })
            ).pipe(
              Effect.map((error) => {
                expect(error).toMatchObject({
                  _tag: "PullPathError",
                  path: `safe/${alias}`,
                });
              })
            );
          });
          expect(yield* Effect.promise(() => readdir(workspace))).toEqual([]);
        })
      )
  );
});
