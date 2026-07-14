import { describe, expect, spyOn, test } from "bun:test";
import { promises as hostFileSystem } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { Effect, Fiber, Stream } from "effect";
import {
  materializePull,
  type PullFileEntry,
  type PullManifest,
  type PullRead,
  preparePull,
} from "../src/index";
import { collectError, oneChunk, pathExists, withFixture } from "./support";

describe("pull transfer destination", () => {
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
