import { describe, expect, spyOn, test } from "bun:test";
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
import { Effect, Fiber, Result, Stream } from "effect";
import {
  materializePull,
  PullPathError,
  type PullRead,
  preparePull,
  resolvePullDestination,
} from "../src/index";
import { collectError, streamSource, waitUntil, withFixture } from "./support";

describe("pull transfer source", () => {
  test("defaults the destination to the remote basename", () => {
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
        `folder/${"a".repeat(4096)}`,
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
});
