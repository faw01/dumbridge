import { describe, expect, spyOn, test } from "bun:test";
import { constants, promises as hostFileSystem } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Effect, Fiber, Stream } from "effect";
import { ServedRoot } from "../src/files/served-root";
import {
  materializePull,
  type PullFileEntry,
  type PullManifest,
  PullPathError,
  type PullRead,
  type PullSource,
  preparePull,
  resolvePullDestination,
} from "../src/pull/transfer";

const withFixture = async <A>(
  use: (fixture: {
    readonly root: string;
    readonly servedRoot: ServedRoot;
    readonly workspace: string;
  }) => Promise<A>
) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "dumbridge-pull-test-"));
  const root = join(temporaryRoot, "served");
  const workspace = join(temporaryRoot, "workspace");
  await Promise.all([
    mkdir(root, { recursive: true }),
    mkdir(workspace, { recursive: true }),
  ]);
  const servedRoot = await Effect.runPromise(ServedRoot.make(root));

  try {
    return await use({ root, servedRoot, workspace });
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
};

const collectError = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.flip(effect));

const oneChunk = (chunk: Uint8Array) => Stream.make(chunk);

const streamSource = async (source: PullSource) => {
  for (const entry of source.manifest.entries) {
    if (entry.kind === "file") {
      // biome-ignore lint/performance/noAwaitInLoops: Tests model the server's ordered transfer.
      await Effect.runPromise(
        Stream.runDrain(source.read(entry, new AbortController().signal))
      );
    }
  }
};

const pathExists = async (path: string) => {
  try {
    await lstat(path);
    return true;
  } catch (cause) {
    if (
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      cause.code === "ENOENT"
    ) {
      return false;
    }
    throw cause;
  }
};

const waitUntil = async (condition: () => boolean) => {
  const deadline = Date.now() + 1000;
  while (!condition() && Date.now() < deadline) {
    // biome-ignore lint/performance/noAwaitInLoops: Test polling yields to the source scan.
    await new Promise((resolveWait) => setTimeout(resolveWait, 1));
  }
};

describe("pull transfer", () => {
  test("defaults the destination to the remote basename", () => {
    expect(resolvePullDestination("photos/cat.jpeg")).toBe("./cat.jpeg");
    expect(resolvePullDestination("photos/cat.jpeg", "images/cat.jpeg")).toBe(
      "images/cat.jpeg"
    );
    expect(() => resolvePullDestination("../cat.jpeg", "cat.jpeg")).toThrow(
      PullPathError
    );
  });

  test("plans and materializes a deterministic directory", () =>
    withFixture(async ({ root, servedRoot, workspace }) => {
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

      const source = await Effect.runPromise(
        preparePull({ remotePath: "project", servedRoot })
      );

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
      const result = await Effect.runPromise(
        materializePull({
          destination,
          manifest: source.manifest,
          read: source.read,
        })
      );

      expect(result).toEqual({ bytes: 9, files: 2 });
      expect(await readFile(join(destination, "a.txt"), "utf8")).toBe("alpha");
      expect(
        new Uint8Array(await readFile(join(destination, "nested", "image.bin")))
      ).toEqual(new Uint8Array([0, 1, 2, 255]));
      expect(await readdir(join(destination, "empty"))).toEqual([]);
    }));

  test("pulls a live uncommitted file", () =>
    withFixture(async ({ root, servedRoot, workspace }) => {
      await writeFile(join(root, ".env"), "LOCAL_ONLY=yes\n");
      const source = await Effect.runPromise(
        preparePull({ remotePath: ".env", servedRoot })
      );
      const destination = join(workspace, ".env.local");

      await Effect.runPromise(
        materializePull({
          destination,
          manifest: source.manifest,
          read: source.read,
        })
      );

      expect(await readFile(destination, "utf8")).toBe("LOCAL_ONLY=yes\n");
    }));

  test("refuses traversal, absolute paths, and separator tricks", () =>
    withFixture(async ({ servedRoot }) => {
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
      ];

      const errors = await Promise.all(
        paths.map(async (remotePath) => ({
          error: await collectError(preparePull({ remotePath, servedRoot })),
          remotePath,
        }))
      );
      for (const { error, remotePath } of errors) {
        expect(error).toMatchObject({
          _tag: "PullPathError",
          path: remotePath,
        });
      }
    }));

  test("refuses symlinks anywhere in the selection", () =>
    withFixture(async ({ root, servedRoot }) => {
      const outside = join(root, "outside");
      const selected = join(root, "selected");
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

      const error = await collectError(
        preparePull({ remotePath: "selected", servedRoot })
      );

      expect(error).toMatchObject({
        _tag: "PullSymlinkError",
        path: "selected/escape",
      });
    }));

  test("refuses a selection below an outside-root ancestor symlink", () =>
    withFixture(async ({ root, servedRoot }) => {
      const outside = join(dirname(root), "outside-root");
      const selected = join(root, "selected");
      await mkdir(outside, { recursive: true });
      await mkdir(selected);
      await writeFile(join(outside, "secret.txt"), "secret");
      await symlink(
        outside,
        join(selected, "escape"),
        process.platform === "win32" ? "junction" : "dir"
      );

      const error = await collectError(
        preparePull({
          remotePath: "selected/escape/secret.txt",
          servedRoot,
        })
      );

      expect(error).toMatchObject({
        _tag: "PullSymlinkError",
        path: "selected/escape",
      });
    }));

  test("fails when the source changes after planning", () =>
    withFixture(async ({ root, servedRoot, workspace }) => {
      const sourcePath = join(root, "draft.txt");
      await writeFile(sourcePath, "first");
      const source = await Effect.runPromise(
        preparePull({ remotePath: "draft.txt", servedRoot })
      );
      await writeFile(sourcePath, "other");

      const error = await collectError(
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
      expect(await readdir(workspace)).toEqual([]);
    }));

  test.skipIf(process.platform === "win32")(
    "fails promptly when a planned file is replaced by a FIFO",
    () =>
      withFixture(async ({ root, servedRoot, workspace }) => {
        const sourcePath = join(root, "draft.txt");
        await writeFile(sourcePath, "first");
        const source = await Effect.runPromise(
          preparePull({ remotePath: "draft.txt", servedRoot })
        );
        const originalOpen = hostFileSystem.open;
        const openCandidate = spyOn(hostFileSystem, "open");
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

        try {
          const transfer = collectError(
            materializePull({
              destination: join(workspace, "draft.txt"),
              manifest: source.manifest,
              read: source.read,
            })
          );
          const outcome = await Promise.race([
            transfer.then((error) => ({ error, status: "completed" as const })),
            Bun.sleep(1000).then(() => ({ status: "blocked" as const })),
          ]);

          if (outcome.status === "blocked") {
            // biome-ignore lint/suspicious/noBitwiseOperators: POSIX open flags compose as a bitmask.
            const releaseFlags = constants.O_RDWR | constants.O_NONBLOCK;
            const release = await open(sourcePath, releaseFlags);
            try {
              await transfer;
            } finally {
              await release.close();
            }
            throw new Error("pull blocked while opening a replaced FIFO");
          }

          expect(outcome.error).toMatchObject({
            _tag: "ServedRootChangedError",
            message: "served root changed after bridge start",
          });
          expect(await readdir(workspace)).toEqual([]);
        } finally {
          openCandidate.mockRestore();
        }
      })
  );

  test("refuses an intermediate symlink introduced after planning", () =>
    withFixture(async ({ root, servedRoot, workspace }) => {
      const sourceDirectory = join(root, "selected", "nested");
      const outside = join(dirname(root), "late-outside-root");
      await mkdir(sourceDirectory, { recursive: true });
      await mkdir(outside);
      await writeFile(join(sourceDirectory, "file.txt"), "inside");
      await writeFile(join(outside, "file.txt"), "outside");
      const source = await Effect.runPromise(
        preparePull({
          remotePath: "selected/nested/file.txt",
          servedRoot,
        })
      );
      await rm(sourceDirectory, { recursive: true });
      await symlink(
        outside,
        sourceDirectory,
        process.platform === "win32" ? "junction" : "dir"
      );

      const error = await collectError(
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
      expect(await readdir(workspace)).toEqual([]);
    }));

  test("fails when the source changes during streaming", () =>
    withFixture(async ({ root, servedRoot, workspace }) => {
      const sourcePath = join(root, "draft.txt");
      await writeFile(sourcePath, "abcdef");
      const source = await Effect.runPromise(
        preparePull({
          limits: { chunkBytes: 2 },
          remotePath: "draft.txt",
          servedRoot,
        })
      );

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

      const error = await collectError(
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
      expect(await readdir(workspace)).toEqual([]);
    }));

  test("fails completion verification when a directory member is added", () =>
    withFixture(async ({ root, servedRoot }) => {
      await mkdir(join(root, "selected"));
      await writeFile(join(root, "selected", "planned.txt"), "planned");
      const source = await Effect.runPromise(
        preparePull({ remotePath: "selected", servedRoot })
      );
      await streamSource(source);
      await writeFile(join(root, "selected", "added.txt"), "added");

      const error = await collectError(source.verify);

      expect(error).toMatchObject({
        _tag: "PullSourceChangedError",
        path: "selected",
      });
    }));

  test("fails completion verification when a streamed file is deleted", () =>
    withFixture(async ({ root, servedRoot }) => {
      await mkdir(join(root, "selected"));
      const path = join(root, "selected", "planned.txt");
      await writeFile(path, "planned");
      const source = await Effect.runPromise(
        preparePull({ remotePath: "selected", servedRoot })
      );
      await streamSource(source);
      await rm(path);

      const error = await collectError(source.verify);

      expect(error).toMatchObject({
        _tag: "PullSourceChangedError",
        path: "selected",
      });
    }));

  test("fails completion verification when a streamed file is replaced", () =>
    withFixture(async ({ root, servedRoot }) => {
      await mkdir(join(root, "selected"));
      const path = join(root, "selected", "planned.txt");
      await writeFile(path, "planned");
      const source = await Effect.runPromise(
        preparePull({ remotePath: "selected", servedRoot })
      );
      await streamSource(source);
      await rm(path);
      await writeFile(path, "planned");

      const error = await collectError(source.verify);

      expect(error).toMatchObject({
        _tag: "PullSourceChangedError",
      });
    }));

  test("fails completion verification when a planned empty directory is removed", () =>
    withFixture(async ({ root, servedRoot }) => {
      await mkdir(join(root, "selected", "empty"), { recursive: true });
      const source = await Effect.runPromise(
        preparePull({ remotePath: "selected", servedRoot })
      );
      await streamSource(source);
      await rm(join(root, "selected", "empty"), { recursive: true });

      const error = await collectError(source.verify);

      expect(error).toMatchObject({
        _tag: "PullSourceChangedError",
        path: "selected",
      });
    }));

  test("bounds completion verification when new entries exceed the limit", () =>
    withFixture(async ({ root, servedRoot }) => {
      await mkdir(join(root, "selected"));
      await writeFile(join(root, "selected", "planned.txt"), "planned");
      const source = await Effect.runPromise(
        preparePull({
          limits: { maxEntries: 1 },
          remotePath: "selected",
          servedRoot,
        })
      );
      await streamSource(source);
      await writeFile(join(root, "selected", "added.txt"), "added");

      const error = await collectError(source.verify);

      expect(error).toMatchObject({
        _tag: "PullLimitError",
        limit: "entries",
        maximum: 1,
        observed: 2,
      });
    }));

  test("verifies received bytes before exposing the destination", () =>
    withFixture(async ({ root, servedRoot, workspace }) => {
      await writeFile(join(root, "cat.jpeg"), new Uint8Array([1, 2, 3]));
      const source = await Effect.runPromise(
        preparePull({ remotePath: "cat.jpeg", servedRoot })
      );

      const error = await collectError(
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
      expect(await readdir(workspace)).toEqual([]);
    }));

  test("rejects reader chunks above the receiver limit", () =>
    withFixture(async ({ root, servedRoot, workspace }) => {
      const bytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
      await writeFile(join(root, "large-frame.bin"), bytes);
      const source = await Effect.runPromise(
        preparePull({ remotePath: "large-frame.bin", servedRoot })
      );

      const error = await collectError(
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
      expect(await readdir(workspace)).toEqual([]);
    }));

  test("removes new parent directories after a reader failure", () =>
    withFixture(async ({ root, servedRoot, workspace }) => {
      await writeFile(join(root, "broken.txt"), "broken");
      const existingParent = join(workspace, "existing");
      await mkdir(existingParent);
      await writeFile(join(existingParent, "keep.txt"), "keep");
      const source = await Effect.runPromise(
        preparePull({ remotePath: "broken.txt", servedRoot })
      );

      const error = await collectError(
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
      expect(await readdir(workspace)).toEqual(["existing"]);
      expect(await readdir(existingParent)).toEqual(["keep.txt"]);
      expect(await readFile(join(existingParent, "keep.txt"), "utf8")).toBe(
        "keep"
      );
    }));

  test("maps a reader failure and removes its staging directory", () =>
    withFixture(async ({ root, servedRoot, workspace }) => {
      await writeFile(join(root, "broken.txt"), "broken");
      const source = await Effect.runPromise(
        preparePull({ remotePath: "broken.txt", servedRoot })
      );

      const error = await collectError(
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
      expect(await readdir(workspace)).toEqual([]);
    }));

  test("interrupts a stalled reader and removes its staging directory", () =>
    withFixture(async ({ root, servedRoot, workspace }) => {
      await writeFile(join(root, "stalled.txt"), "stalled");
      const source = await Effect.runPromise(
        preparePull({ remotePath: "stalled.txt", servedRoot })
      );
      let readerSignal: AbortSignal | undefined;
      let readerStarted: (() => void) | undefined;
      const started = new Promise<void>((resolveStarted) => {
        readerStarted = resolveStarted;
      });
      const stalledRead = (_entry: PullFileEntry, signal: AbortSignal) => {
        readerSignal = signal;
        readerStarted?.();
        return Stream.never;
      };
      const fiber = Effect.runFork(
        materializePull({
          destination: join(workspace, "stalled.txt"),
          manifest: source.manifest,
          read: stalledRead,
        })
      );

      await started;
      await Effect.runPromise(
        Fiber.interrupt(fiber).pipe(Effect.timeout("1 second"))
      );

      expect(readerSignal?.aborted).toBe(true);
      expect(await readdir(workspace)).toEqual([]);
    }));

  test("propagates prepare cancellation into source scanning", () =>
    withFixture(async ({ root, servedRoot }) => {
      const sourcePath = join(root, "large.bin");
      await writeFile(sourcePath, "");
      await truncate(sourcePath, 1024 * 1024 * 1024);

      const originalThrowIfAborted = AbortSignal.prototype.throwIfAborted;
      let checks = 0;
      let observedAbort = false;
      function throwIfAborted(this: AbortSignal) {
        checks += 1;
        observedAbort ||= this.aborted;
        return originalThrowIfAborted.call(this);
      }
      Object.defineProperty(AbortSignal.prototype, "throwIfAborted", {
        configurable: true,
        value: throwIfAborted,
        writable: true,
      });

      try {
        const fiber = Effect.runFork(
          preparePull({ remotePath: "large.bin", servedRoot })
        );
        await waitUntil(() => checks >= 5);
        expect(checks).toBeGreaterThanOrEqual(5);

        await Effect.runPromise(Fiber.interrupt(fiber));
        await waitUntil(() => observedAbort);

        expect(observedAbort).toBe(true);
      } finally {
        Object.defineProperty(AbortSignal.prototype, "throwIfAborted", {
          configurable: true,
          value: originalThrowIfAborted,
          writable: true,
        });
      }
    }));

  test("refuses an existing destination", () =>
    withFixture(async ({ root, servedRoot, workspace }) => {
      await writeFile(join(root, "file.txt"), "new");
      const destination = join(workspace, "file.txt");
      await writeFile(destination, "keep");
      const source = await Effect.runPromise(
        preparePull({ remotePath: "file.txt", servedRoot })
      );

      const error = await collectError(
        materializePull({
          destination,
          manifest: source.manifest,
          read: source.read,
        })
      );

      expect(error).toMatchObject({ _tag: "PullDestinationExistsError" });
      expect(await readFile(destination, "utf8")).toBe("keep");
    }));

  test("never replaces a file created while bytes are staged", () =>
    withFixture(async ({ root, servedRoot, workspace }) => {
      await writeFile(join(root, "file.txt"), "incoming");
      const source = await Effect.runPromise(
        preparePull({ remotePath: "file.txt", servedRoot })
      );
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

      const error = await collectError(
        materializePull({
          destination,
          manifest: source.manifest,
          read: racingRead,
        })
      );

      expect(error).toMatchObject({ _tag: "PullDestinationExistsError" });
      expect(await readFile(destination, "utf8")).toBe("keep");
      expect(await readdir(workspace)).toEqual(["file.txt"]);
    }));

  test("exposes a verified directory in one commit", () =>
    withFixture(async ({ root, servedRoot, workspace }) => {
      await mkdir(join(root, "folder"));
      await Promise.all([
        writeFile(join(root, "folder", "a.txt"), "alpha"),
        writeFile(join(root, "folder", "b.txt"), "beta"),
      ]);
      const source = await Effect.runPromise(
        preparePull({ remotePath: "folder", servedRoot })
      );
      const destination = join(workspace, "folder");
      let releaseRead: (() => void) | undefined;
      let readerStarted: (() => void) | undefined;
      const mayRead = new Promise<void>((resolveRead) => {
        releaseRead = resolveRead;
      });
      const started = new Promise<void>((resolveStarted) => {
        readerStarted = resolveStarted;
      });
      const gatedRead: PullRead = (entry, signal) =>
        Stream.unwrap(
          Effect.promise(async () => {
            readerStarted?.();
            await mayRead;
            return source.read(entry, signal);
          })
        );
      const fiber = Effect.runFork(
        materializePull({
          destination,
          manifest: source.manifest,
          read: gatedRead,
        })
      );

      await started;
      try {
        expect(await pathExists(destination)).toBe(false);
      } finally {
        releaseRead?.();
      }
      await Effect.runPromise(Fiber.join(fiber));

      expect((await readdir(destination)).sort()).toEqual(["a.txt", "b.txt"]);
      expect(await readFile(join(destination, "a.txt"), "utf8")).toBe("alpha");
      expect(await readFile(join(destination, "b.txt"), "utf8")).toBe("beta");
    }));

  test("keeps a published pull successful when staging cleanup fails", () =>
    withFixture(async ({ root, servedRoot, workspace }) => {
      await writeFile(join(root, "published.txt"), "published");
      const source = await Effect.runPromise(
        preparePull({ remotePath: "published.txt", servedRoot })
      );
      const destination = join(workspace, "published.txt");
      const remove = hostFileSystem.rm;
      const removeSpy = spyOn(hostFileSystem, "rm");
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

      try {
        const result = await Effect.runPromise(
          materializePull({
            destination,
            manifest: source.manifest,
            read: source.read,
          })
        );

        expect(result).toEqual({ bytes: 9, files: 1 });
        expect(await readFile(destination, "utf8")).toBe("published");
        const stages = (await readdir(workspace)).filter((name) =>
          name.startsWith(".dumbridge-pull-")
        );
        expect(stages).toHaveLength(1);
        const [stage] = stages;
        if (stage === undefined) {
          throw new Error("the failed cleanup did not leave its stage");
        }
        expect(await readdir(join(workspace, stage))).toEqual([]);
      } finally {
        removeSpy.mockRestore();
      }
    }));

  test("never replaces a directory created while bytes are staged", () =>
    withFixture(async ({ root, servedRoot, workspace }) => {
      await mkdir(join(root, "folder"));
      await writeFile(join(root, "folder", "file.txt"), "new");
      const source = await Effect.runPromise(
        preparePull({ remotePath: "folder", servedRoot })
      );
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

      const error = await collectError(
        materializePull({
          destination,
          manifest: source.manifest,
          read: racingRead,
        })
      );

      expect(error).toMatchObject({ _tag: "PullDestinationExistsError" });
      expect(await readdir(destination)).toEqual([]);
      expect(await readdir(workspace)).toEqual(["folder"]);
    }));

  test("rejects the aggregate byte limit before opening the next file", () =>
    withFixture(async ({ root, servedRoot }) => {
      const sourcePath = join(root, "too-large.txt");
      await writeFile(sourcePath, "12");
      if (process.platform !== "win32") {
        await chmod(sourcePath, 0);
      }

      try {
        const error = await collectError(
          preparePull({
            limits: { maxTotalBytes: 1 },
            remotePath: "too-large.txt",
            servedRoot,
          })
        );

        expect(error).toMatchObject({
          _tag: "PullLimitError",
          limit: "total bytes",
          maximum: 1,
          observed: 2,
        });
      } finally {
        if (process.platform !== "win32") {
          await chmod(sourcePath, 0o600);
        }
      }
    }));

  test("rejects a served root that was rebound after bridge start", () =>
    withFixture(async ({ root, servedRoot }) => {
      const parkedRoot = `${root}-parked`;
      const outside = join(dirname(root), "outside-rebound-root");
      await mkdir(outside);
      await writeFile(join(outside, "secret.txt"), "outside secret");
      await rename(root, parkedRoot);
      await symlink(
        outside,
        root,
        process.platform === "win32" ? "junction" : "dir"
      );

      const error = await collectError(
        preparePull({ remotePath: "secret.txt", servedRoot })
      );

      expect(error).toMatchObject({ _tag: "ServedRootChangedError" });
    }));

  test("enforces manifest entry and byte limits", () =>
    withFixture(async ({ root, servedRoot }) => {
      await mkdir(join(root, "many"), { recursive: true });
      await Promise.all([
        writeFile(join(root, "many", "a"), "12"),
        writeFile(join(root, "many", "b"), "34"),
      ]);

      const entryError = await collectError(
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

      const byteError = await collectError(
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
    }));

  test("rejects a malicious manifest path before writing", () =>
    withFixture(async ({ workspace }) => {
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

      const error = await collectError(
        materializePull({
          destination: join(workspace, "files"),
          manifest,
          read: () => oneChunk(new Uint8Array()),
        })
      );

      expect(error).toMatchObject({ _tag: "PullPathError", path: "../escape" });
      expect(await readdir(workspace)).toEqual([]);
    }));

  test("rejects Windows device aliases in received manifest components", () =>
    withFixture(async ({ workspace }) => {
      const aliases = ["CONIN$", "conout$.txt", "CON .txt", "AUX .log"];

      for (const alias of aliases) {
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

        // biome-ignore lint/performance/noAwaitInLoops: Each alias must be rejected independently.
        const error = await collectError(
          materializePull({
            destination: join(workspace, alias),
            manifest,
            read: () => oneChunk(new Uint8Array()),
          })
        );

        expect(error).toMatchObject({
          _tag: "PullPathError",
          path: `safe/${alias}`,
        });
      }
      expect(await readdir(workspace)).toEqual([]);
    }));
});
