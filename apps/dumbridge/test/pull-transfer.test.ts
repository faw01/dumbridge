import { describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import {
  materializePull,
  type PullManifest,
  preparePull,
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

const oneChunk = async function* (chunk: Uint8Array) {
  yield await Promise.resolve(chunk);
};

describe("pull transfer", () => {
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
        "C:\\secret",
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

      const readAndMutate = async function* (
        entry: Parameters<typeof source.read>[0]
      ) {
        let first = true;
        for await (const chunk of source.read(entry)) {
          yield chunk;
          if (first) {
            first = false;
            await writeFile(sourcePath, "ghijkl");
          }
        }
      };

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
});
