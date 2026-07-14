import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServedRoot, type SourceFileScan } from "@dumbridge/served-root";
import { Effect } from "effect";

let fixtureRoot = "";
let servedPath = "";
let outsidePath = "";

beforeEach(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "dumbridge-pull-view-"));
  servedPath = join(fixtureRoot, "served");
  outsidePath = join(fixtureRoot, "outside");
  await Promise.all([mkdir(servedPath), mkdir(outsidePath)]);
});

afterEach(async () => {
  await rm(fixtureRoot, { force: true, recursive: true });
});

const caught = async (operation: () => Promise<unknown>) => {
  try {
    await operation();
  } catch (cause) {
    return cause;
  }
  throw new Error("expected operation to fail");
};

const consumeScan = async (
  generator: AsyncGenerator<Uint8Array, SourceFileScan>
) => {
  const chunks: Uint8Array[] = [];
  let next = await generator.next();
  while (!next.done) {
    chunks.push(next.value);
    // biome-ignore lint/performance/noAwaitInLoops: An async generator must be consumed in order.
    next = await generator.next();
  }
  return {
    bytes: Buffer.concat(chunks).toString("utf8"),
    scan: next.value,
  };
};

describe("ServedRoot pull view", () => {
  test("inspects, lists, and scans through one sealed pull-shaped view", async () => {
    await mkdir(join(servedPath, "selected"));
    await Promise.all([
      writeFile(join(servedPath, "selected", "z.txt"), "z"),
      writeFile(join(servedPath, "selected", "a.txt"), "abcdef"),
    ]);
    const root = await Effect.runPromise(ServedRoot.make(servedPath));
    const view = root.openPullView();
    const { signal } = new AbortController();
    let reserved = 0;

    const directory = await view.inspect("selected", {}, signal);
    const listed = await view.list(
      "selected",
      {
        expected: directory.revision,
        reserve: () => {
          reserved += 1;
        },
      },
      signal
    );
    const file = await view.inspect("selected/a.txt", {}, signal);
    const planned = await consumeScan(
      view.scan({
        chunkBytes: 2,
        maxFileBytes: 1024,
        path: "selected/a.txt",
        signal,
      })
    );
    const verified = await consumeScan(
      view.scan({
        chunkBytes: 3,
        expected: planned.scan,
        maxFileBytes: 1024,
        path: "selected/a.txt",
        signal,
      })
    );

    expect(Object.keys(view).sort()).toEqual(["inspect", "list", "scan"]);
    expect(Object.isFrozen(view)).toBe(true);
    expect(JSON.stringify(view)).not.toContain(servedPath);
    expect(directory.kind).toBe("directory");
    expect(listed.children).toEqual(["a.txt", "z.txt"]);
    expect(reserved).toBe(2);
    expect(file).toMatchObject({
      kind: "file",
      path: "selected/a.txt",
      size: 6,
    });
    expect(Object.keys(file.revision)).toEqual([]);
    expect(JSON.stringify(file.revision)).toBe("{}");
    expect(planned.bytes).toBe("abcdef");
    expect(planned.scan).toMatchObject({
      digest:
        "bef57ec7f53a6d40beb640a780a639c83bc29ac8a9816f1fc6c5c6dcd93c4721",
      size: 6,
    });
    expect(verified.bytes).toBe("abcdef");
  });

  test("accepts only canonical relative remote paths", async () => {
    const root = await Effect.runPromise(ServedRoot.make(servedPath));
    const view = root.openPullView();
    const { signal } = new AbortController();
    const paths = [
      "",
      "/absolute",
      "../outside",
      "folder/../outside",
      "folder//file",
      "folder\\file",
      "C:relative",
      "folder/CON",
      "folder/CON .txt",
      "conout$.log",
      "folder/name.",
      "folder/name ",
      "folder/has<angle",
      "folder/file.txt:stream",
    ];

    const errors = await Promise.all(
      paths.map((path) => caught(() => view.inspect(path, {}, signal)))
    );

    for (const [index, error] of errors.entries()) {
      expect(error).toMatchObject({
        _tag: "ServedRootPathError",
        path: paths[index],
      });
    }
  });

  test("rejects a symlink in any selected path component", async () => {
    await mkdir(join(servedPath, "selected"));
    await writeFile(join(outsidePath, "secret.txt"), "outside");
    await symlink(
      outsidePath,
      join(servedPath, "selected", "escape"),
      process.platform === "win32" ? "junction" : "dir"
    );
    const root = await Effect.runPromise(ServedRoot.make(servedPath));
    const view = root.openPullView();

    const error = await caught(() =>
      view.inspect(
        "selected/escape/secret.txt",
        {},
        new AbortController().signal
      )
    );

    expect(error).toMatchObject({
      _tag: "ServedRootSymlinkError",
      path: "selected/escape",
    });
    expect(JSON.stringify(error)).not.toContain(outsidePath);
    expect(JSON.stringify(error)).not.toContain(servedPath);
  });

  test("compares an opaque revision only when it is passed back", async () => {
    const path = join(servedPath, "draft.txt");
    await writeFile(path, "first");
    const root = await Effect.runPromise(ServedRoot.make(servedPath));
    const view = root.openPullView();
    const { signal } = new AbortController();
    const planned = await view.inspect("draft.txt", {}, signal);
    await writeFile(path, "replacement");

    const error = await caught(() =>
      view.inspect("draft.txt", { expected: planned.revision }, signal)
    );

    expect(error).toMatchObject({
      _tag: "ServedRootSourceChangedError",
      path: "draft.txt",
    });
  });

  test("bounds a file before yielding bytes", async () => {
    await writeFile(join(servedPath, "large.txt"), "abcdef");
    const root = await Effect.runPromise(ServedRoot.make(servedPath));
    const view = root.openPullView();
    const generator = view.scan({
      chunkBytes: 2,
      maxFileBytes: 5,
      path: "large.txt",
      signal: new AbortController().signal,
    });

    const error = await caught(() => generator.next());

    expect(error).toMatchObject({
      _tag: "ServedRootFileLimitError",
      maximum: 5,
      observed: 6,
      path: "large.txt",
    });
  });

  test("closes a bounded directory and preserves the caller's reservation error", async () => {
    await mkdir(join(servedPath, "selected"));
    await writeFile(join(servedPath, "selected", "file.txt"), "content");
    const root = await Effect.runPromise(ServedRoot.make(servedPath));
    const view = root.openPullView();
    const reservationError = new Error("entry budget exhausted");

    const error = await caught(() =>
      view.list(
        "selected",
        {
          reserve: () => {
            throw reservationError;
          },
        },
        new AbortController().signal
      )
    );

    expect(error).toBe(reservationError);
  });

  test("honors cancellation before touching the source", async () => {
    await writeFile(join(servedPath, "file.txt"), "content");
    const root = await Effect.runPromise(ServedRoot.make(servedPath));
    const view = root.openPullView();
    const controller = new AbortController();
    const reason = new Error("cancelled");
    controller.abort(reason);
    const generator = view.scan({
      chunkBytes: 2,
      maxFileBytes: 1024,
      path: "file.txt",
      signal: controller.signal,
    });

    const error = await caught(() => generator.next());

    expect(error).toBe(reason);
  });
});
