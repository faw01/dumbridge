import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
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
  test("opens an alias behind a fixed virtual read view", async () => {
    const alias = join(fixtureRoot, "alias");
    await writeFile(join(servedPath, "marker.txt"), "served marker\n");
    await symlink(
      servedPath,
      alias,
      process.platform === "win32" ? "junction" : "dir"
    );

    const root = await Effect.runPromise(ServedRoot.make(alias));
    const view = root.openReadView({
      maxFileReadBytes: 1024,
      maxOverlayBytes: 1024,
      maxOverlayEntries: 32,
    });
    await Effect.runPromise(root.verify());

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
      await view.fileSystem.readFile("/workspace/marker.txt", "utf8")
    ).toBe("served marker\n");
  });

  test("keeps accepting live changes within the same directory", async () => {
    const root = await Effect.runPromise(ServedRoot.make(servedPath));
    const view = root.openReadView({
      maxFileReadBytes: 1024,
      maxOverlayBytes: 1024,
      maxOverlayEntries: 32,
    });
    await writeFile(join(servedPath, "uncommitted.txt"), "live\n");

    await Effect.runPromise(root.verify());

    expect(
      await view.fileSystem.readFile("/workspace/uncommitted.txt", "utf8")
    ).toBe("live\n");
  });

  test("releases a failed host-read reservation", async () => {
    await writeFile(join(servedPath, "fixture.txt"), "1234");
    const root = await Effect.runPromise(ServedRoot.make(servedPath));
    const view = root.openReadView({
      maxFileReadBytes: 4,
      maxOverlayBytes: 4,
      maxOverlayEntries: 4,
    });
    view.begin(new AbortController().signal);
    const open = spyOn(hostFileSystem, "open");
    open.mockImplementationOnce(() =>
      Promise.reject(new Error("EIO: simulated host read failure"))
    );

    try {
      await expect(
        view.fileSystem.readFileBuffer("/workspace/fixture.txt")
      ).rejects.toThrow("unable to read");
    } finally {
      open.mockRestore();
    }

    expect(
      await view.fileSystem.readFile("/workspace/fixture.txt", "utf8")
    ).toBe("1234");
  });

  test("rejects a path rebound to another directory", async () => {
    const root = await Effect.runPromise(ServedRoot.make(servedPath));
    await rename(servedPath, join(fixtureRoot, "original-served"));
    await symlink(
      outsidePath,
      servedPath,
      process.platform === "win32" ? "junction" : "dir"
    );

    const error = await Effect.runPromise(Effect.flip(root.verify()));

    expect(error).toMatchObject({
      _tag: "ServedRootChangedError",
      message: "served root changed after bridge start",
    });
  });
});
