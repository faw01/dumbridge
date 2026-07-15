import { promises as hostFileSystem } from "node:fs";
import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServedRoot } from "@dumbridge/served-root";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "@effect/vitest";
import { Effect } from "effect";

let fixtureRoot = "";
let servedPath = "";
let outsidePath = "";

beforeEach(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "dumbridge-served-root-"));
  servedPath = join(fixtureRoot, "served");
  outsidePath = join(fixtureRoot, "outside");
  await Promise.all([mkdir(servedPath), mkdir(outsidePath)]);
});

afterEach(async () => {
  await rm(fixtureRoot, { force: true, recursive: true });
});

describe("ServedRoot", () => {
  it.effect("opens an alias behind a fixed virtual read view", () =>
    Effect.gen(function* () {
      const alias = join(fixtureRoot, "alias");
      yield* Effect.promise(() =>
        writeFile(join(servedPath, "marker.txt"), "served marker\n")
      );
      yield* Effect.promise(() =>
        symlink(
          servedPath,
          alias,
          process.platform === "win32" ? "junction" : "dir"
        )
      );

      const root = yield* ServedRoot.make(alias);
      const view = root.openReadView({
        maxFileReadBytes: 1024,
        maxOverlayBytes: 1024,
        maxOverlayEntries: 32,
      });
      yield* root.verify();

      expect("path" in root).toBe(false);
      expect("root" in view.fileSystem).toBe(false);
      expect("getMountPoint" in view.fileSystem).toBe(false);
      expect(Object.isFrozen(view)).toBe(true);
      expect(Object.isFrozen(view.fileSystem)).toBe(true);
      expect(JSON.stringify(root)).not.toContain(alias);
      expect(JSON.stringify(root)).not.toContain(servedPath);
      expect(JSON.stringify(view)).not.toContain(servedPath);
      expect(JSON.stringify(view.fileSystem)).not.toContain(servedPath);
      expect(view.workingDirectory).toBe("/workspace");
      expect(
        yield* Effect.promise(() =>
          view.fileSystem.readFile("/workspace/marker.txt", "utf8")
        )
      ).toBe("served marker\n");
    })
  );

  it.effect("keeps accepting live changes within the same directory", () =>
    Effect.gen(function* () {
      const root = yield* ServedRoot.make(servedPath);
      const view = root.openReadView({
        maxFileReadBytes: 1024,
        maxOverlayBytes: 1024,
        maxOverlayEntries: 32,
      });
      yield* Effect.promise(() =>
        writeFile(join(servedPath, "uncommitted.txt"), "live\n")
      );

      yield* root.verify();

      expect(
        yield* Effect.promise(() =>
          view.fileSystem.readFile("/workspace/uncommitted.txt", "utf8")
        )
      ).toBe("live\n");
    })
  );

  it.effect("releases a failed host-read reservation", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        writeFile(join(servedPath, "fixture.txt"), "1234")
      );
      const root = yield* ServedRoot.make(servedPath);
      const view = root.openReadView({
        maxFileReadBytes: 4,
        maxOverlayBytes: 4,
        maxOverlayEntries: 4,
      });
      view.begin(new AbortController().signal);
      const open = vi.spyOn(hostFileSystem, "open");
      open.mockImplementationOnce(() =>
        Promise.reject(new Error("EIO: simulated host read failure"))
      );

      try {
        yield* Effect.promise(() =>
          expect(
            view.fileSystem.readFileBuffer("/workspace/fixture.txt")
          ).rejects.toThrow("unable to read")
        );
      } finally {
        open.mockRestore();
      }

      expect(
        yield* Effect.promise(() =>
          view.fileSystem.readFile("/workspace/fixture.txt", "utf8")
        )
      ).toBe("1234");
    })
  );

  it.effect("rejects a path rebound to another directory", () =>
    Effect.gen(function* () {
      const root = yield* ServedRoot.make(servedPath);
      yield* Effect.promise(() =>
        rename(servedPath, join(fixtureRoot, "original-served"))
      );
      yield* Effect.promise(() =>
        symlink(
          outsidePath,
          servedPath,
          process.platform === "win32" ? "junction" : "dir"
        )
      );

      const error = yield* Effect.flip(root.verify());

      expect(error).toMatchObject({
        _tag: "ServedRootChangedError",
        message: "served root changed after bridge start",
      });
    })
  );

  it.effect("verifies synchronously for the pull promise engine", () =>
    Effect.gen(function* () {
      const root = yield* ServedRoot.make(servedPath);

      expect(() => root.verifySync()).not.toThrow();

      yield* Effect.promise(() =>
        rename(servedPath, join(fixtureRoot, "original-served"))
      );
      yield* Effect.promise(() =>
        symlink(
          outsidePath,
          servedPath,
          process.platform === "win32" ? "junction" : "dir"
        )
      );

      expect(() => root.verifySync()).toThrow(
        "served root changed after bridge start"
      );
    })
  );

  it.effect("displays only the sanitized final path component", () =>
    Effect.gen(function* () {
      const plain = yield* ServedRoot.make(servedPath);
      expect(plain.displayName).toBe("served");
      expect(plain.displayName).not.toContain(fixtureRoot);

      if (process.platform !== "win32") {
        const hostile = join(
          fixtureRoot,
          "GitHub\nDUMBRIDGE_KEY=counterfeit\u001b[31m"
        );
        yield* Effect.promise(() => mkdir(hostile));
        const sanitized = yield* ServedRoot.make(hostile);
        expect(sanitized.displayName).toBe(
          "GitHubDUMBRIDGE_KEY=counterfeit[31m"
        );
        expect(sanitized.displayName).not.toContain("\u001b");
        expect(sanitized.displayName).not.toContain("\n");
      }
    })
  );

  it.effect("records the first read miss outside the served root", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        writeFile(join(servedPath, "inside.txt"), "inside\n")
      );
      const root = yield* ServedRoot.make(servedPath);
      const view = root.openReadView({
        maxFileReadBytes: 1024,
        maxOverlayBytes: 1024,
        maxOverlayEntries: 32,
      });
      view.begin(new AbortController().signal);

      yield* Effect.promise(() =>
        expect(
          view.fileSystem.readFileBuffer("/workspace/missing.txt")
        ).rejects.toThrow()
      );
      expect(view.outsideRootPath).toBeUndefined();

      yield* Effect.promise(() =>
        expect(view.fileSystem.stat("/Downloads")).rejects.toThrow()
      );
      expect(view.outsideRootPath).toBe("/Downloads");

      yield* Effect.promise(() =>
        expect(view.fileSystem.readFileBuffer("/etc/passwd")).rejects.toThrow()
      );
      expect(view.outsideRootPath).toBe("/Downloads");
    })
  );

  it.effect("keeps overlay scratch reads outside the root unbranded", () =>
    Effect.gen(function* () {
      const root = yield* ServedRoot.make(servedPath);
      const view = root.openReadView({
        maxFileReadBytes: 1024,
        maxOverlayBytes: 1024,
        maxOverlayEntries: 32,
      });
      view.begin(new AbortController().signal);

      yield* Effect.promise(() =>
        view.fileSystem.writeFile("/tmp/scratch.txt", "scratch\n")
      );
      expect(
        yield* Effect.promise(() =>
          view.fileSystem.readFile("/tmp/scratch.txt", "utf8")
        )
      ).toBe("scratch\n");
      expect(view.outsideRootPath).toBeUndefined();
    })
  );
});
