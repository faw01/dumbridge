import { describe, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect, Fiber, Stream } from "effect";
import {
  materializePull,
  type PullFileEntry,
  type PullManifest,
  type PullRead,
  preparePull,
  resolvePullDestination,
} from "../src/pull/transfer";

const withFixture = async <A>(
  use: (fixture: {
    readonly root: string;
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

  try {
    return await use({ root, workspace });
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
};

const collectError = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.flip(effect));

const oneChunk = (chunk: Uint8Array) => Stream.make(chunk);

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

describe("pull transfer", () => {
  test("defaults the destination to the remote basename", () => {
    expect(resolvePullDestination("photos/cat.jpeg")).toBe("./cat.jpeg");
    expect(resolvePullDestination("photos/cat.jpeg", "images/cat.jpeg")).toBe(
      "images/cat.jpeg"
    );
  });

  test("accepts names close to Windows device names", () => {
    const cases = [
      ["console", "./console"],
      ["folder/auxiliary.txt", "./auxiliary.txt"],
      ["folder/com0.txt", "./com0.txt"],
      ["folder/com10.txt", "./com10.txt"],
      ["folder/lpt0", "./lpt0"],
      ["folder/lpt10.log", "./lpt10.log"],
      ["folder/nulled", "./nulled"],
      ["folder/printer", "./printer"],
    ] as const;

    for (const [remotePath, expected] of cases) {
      expect(resolvePullDestination(remotePath)).toBe(expected);
    }
  });

  test("plans and materializes a deterministic directory", () =>
    withFixture(async ({ root, workspace }) => {
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
        preparePull({ remotePath: "project", servedRoot: root })
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
    withFixture(async ({ root, workspace }) => {
      await writeFile(join(root, ".env"), "LOCAL_ONLY=yes\n");
      const source = await Effect.runPromise(
        preparePull({ remotePath: ".env", servedRoot: root })
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
    withFixture(async ({ root }) => {
      const paths = [
        "../secret",
        "/etc/passwd",
        "C:secret",
        "C:\\secret",
        "folder/C:secret",
        "folder/file.txt:stream",
        "CON",
        "folder/PrN.txt",
        "folder/aUx.JSON",
        "folder/Nul",
        "folder/cOm1.log",
        "folder/COM9",
        "folder/lPt1.tar.gz",
        "folder/LPT9",
        "folder/secret\0.txt",
        "folder\\secret",
        "folder//secret",
        "folder/./secret",
      ];

      const errors = await Promise.all(
        paths.map(async (remotePath) => ({
          error: await collectError(
            preparePull({ remotePath, servedRoot: root })
          ),
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
    withFixture(async ({ root }) => {
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
        preparePull({ remotePath: "selected", servedRoot: root })
      );

      expect(error).toMatchObject({
        _tag: "PullSymlinkError",
        path: "selected/escape",
      });
    }));

  test("refuses a selection below an outside-root ancestor symlink", () =>
    withFixture(async ({ root }) => {
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
          servedRoot: root,
        })
      );

      expect(error).toMatchObject({
        _tag: "PullSymlinkError",
        path: "selected/escape",
      });
    }));

  test("fails when the source changes after planning", () =>
    withFixture(async ({ root, workspace }) => {
      const sourcePath = join(root, "draft.txt");
      await writeFile(sourcePath, "first");
      const source = await Effect.runPromise(
        preparePull({ remotePath: "draft.txt", servedRoot: root })
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

  test("refuses an intermediate symlink introduced after planning", () =>
    withFixture(async ({ root, workspace }) => {
      const sourceDirectory = join(root, "selected", "nested");
      const outside = join(dirname(root), "late-outside-root");
      await mkdir(sourceDirectory, { recursive: true });
      await mkdir(outside);
      await writeFile(join(sourceDirectory, "file.txt"), "inside");
      await writeFile(join(outside, "file.txt"), "outside");
      const source = await Effect.runPromise(
        preparePull({
          remotePath: "selected/nested/file.txt",
          servedRoot: root,
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
    withFixture(async ({ root, workspace }) => {
      const sourcePath = join(root, "draft.txt");
      await writeFile(sourcePath, "abcdef");
      const source = await Effect.runPromise(
        preparePull({
          limits: { chunkBytes: 2 },
          remotePath: "draft.txt",
          servedRoot: root,
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

  test("verifies received bytes before exposing the destination", () =>
    withFixture(async ({ root, workspace }) => {
      await writeFile(join(root, "cat.jpeg"), new Uint8Array([1, 2, 3]));
      const source = await Effect.runPromise(
        preparePull({ remotePath: "cat.jpeg", servedRoot: root })
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

  test("removes new parent directories after a reader failure", () =>
    withFixture(async ({ root, workspace }) => {
      await writeFile(join(root, "broken.txt"), "broken");
      const existingParent = join(workspace, "existing");
      await mkdir(existingParent);
      await writeFile(join(existingParent, "keep.txt"), "keep");
      const source = await Effect.runPromise(
        preparePull({ remotePath: "broken.txt", servedRoot: root })
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

  test("removes new parent directories after interruption", () =>
    withFixture(async ({ root, workspace }) => {
      await writeFile(join(root, "stalled.txt"), "stalled");
      const source = await Effect.runPromise(
        preparePull({ remotePath: "stalled.txt", servedRoot: root })
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
          destination: join(workspace, "new", "deep", "stalled.txt"),
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

  test("refuses an existing destination", () =>
    withFixture(async ({ root, workspace }) => {
      await writeFile(join(root, "file.txt"), "new");
      const destination = join(workspace, "file.txt");
      await writeFile(destination, "keep");
      const source = await Effect.runPromise(
        preparePull({ remotePath: "file.txt", servedRoot: root })
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

  test("preserves a directory created after the destination check", () =>
    withFixture(async ({ root, workspace }) => {
      await mkdir(join(root, "folder"));
      await writeFile(join(root, "folder", "incoming.txt"), "incoming");
      const source = await Effect.runPromise(
        preparePull({ remotePath: "folder", servedRoot: root })
      );
      const destination = join(workspace, "folder");
      let destinationCreated = false;
      let destinationIdentity:
        | {
            readonly birthtimeMs: number;
            readonly dev: number;
            readonly ino: number;
          }
        | undefined;
      const racingRead: PullRead = (entry, signal) =>
        source.read(entry, signal).pipe(
          Stream.tap(() => {
            if (destinationCreated) {
              return Effect.void;
            }
            destinationCreated = true;
            return Effect.promise(async () => {
              await mkdir(destination);
              const stats = await lstat(destination);
              destinationIdentity = {
                birthtimeMs: stats.birthtimeMs,
                dev: stats.dev,
                ino: stats.ino,
              };
            });
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
      const destinationAfter = await lstat(destination);
      if (destinationIdentity === undefined) {
        throw new Error("the reader did not create the raced destination");
      }
      expect({
        birthtimeMs: destinationAfter.birthtimeMs,
        dev: destinationAfter.dev,
        ino: destinationAfter.ino,
      }).toEqual(destinationIdentity);
    }));

  test("exposes a verified directory in one commit", () =>
    withFixture(async ({ root, workspace }) => {
      await mkdir(join(root, "folder"));
      await Promise.all([
        writeFile(join(root, "folder", "a.txt"), "alpha"),
        writeFile(join(root, "folder", "b.txt"), "beta"),
      ]);
      const source = await Effect.runPromise(
        preparePull({ remotePath: "folder", servedRoot: root })
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

  test("enforces manifest entry and byte limits", () =>
    withFixture(async ({ root }) => {
      await mkdir(join(root, "many"), { recursive: true });
      await Promise.all([
        writeFile(join(root, "many", "a"), "12"),
        writeFile(join(root, "many", "b"), "34"),
      ]);

      const entryError = await collectError(
        preparePull({
          limits: { maxEntries: 1 },
          remotePath: "many",
          servedRoot: root,
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
          servedRoot: root,
        })
      );
      expect(byteError).toMatchObject({
        _tag: "PullLimitError",
        limit: "total bytes",
      });
    }));

  test("rejects a malicious manifest path before writing", () =>
    withFixture(async ({ workspace }) => {
      const errors = await Promise.all(
        ["../escape", "nested/CoM1.txt"].map(async (entryPath) => {
          const manifest: PullManifest = {
            digestAlgorithm: "sha256",
            entries: [
              {
                digest:
                  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
                kind: "file",
                path: entryPath,
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

          return { entryPath, error };
        })
      );
      for (const { entryPath, error } of errors) {
        expect(error).toMatchObject({ _tag: "PullPathError", path: entryPath });
      }
      expect(await readdir(workspace)).toEqual([]);
    }));
});
