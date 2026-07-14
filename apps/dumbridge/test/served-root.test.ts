import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Buffer } from "node:buffer";
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
import { Effect } from "effect";
import { OverlayFs } from "just-bash";
import { ServedRoot } from "../src/files/served-root";

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

const openReadView = async () => {
  const root = await Effect.runPromise(ServedRoot.make(servedPath));
  const view = root.openReadView({
    maxFileReadBytes: 4,
    maxOverlayBytes: 4,
  });
  view.begin(new AbortController().signal);
  return view;
};

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
    });
    await writeFile(join(servedPath, "uncommitted.txt"), "live\n");

    await Effect.runPromise(root.verify());

    expect(
      await view.fileSystem.readFile("/workspace/uncommitted.txt", "utf8")
    ).toBe("live\n");
  });

  test("releases a failed file-read reservation", async () => {
    await writeFile(join(servedPath, "fixture.txt"), "1234");
    const view = await openReadView();
    const read = spyOn(OverlayFs.prototype, "readFileBuffer");
    read.mockImplementationOnce(() =>
      Promise.reject(new Error("EIO: simulated read failure"))
    );

    try {
      await expect(
        view.fileSystem.readFileBuffer("/workspace/fixture.txt")
      ).rejects.toThrow("simulated read failure");
    } finally {
      read.mockRestore();
    }

    const content = await view.fileSystem.readFileBuffer(
      "/workspace/fixture.txt"
    );
    expect(Buffer.from(content).toString("utf8")).toBe("1234");
  });

  test("releases a failed write reservation", async () => {
    const view = await openReadView();
    const write = spyOn(OverlayFs.prototype, "writeFile");
    write.mockImplementationOnce(() =>
      Promise.reject(new Error("EIO: simulated write failure"))
    );

    try {
      await expect(
        view.fileSystem.writeFile("/workspace/fixture.txt", "1234")
      ).rejects.toThrow("simulated write failure");
    } finally {
      write.mockRestore();
    }

    await view.fileSystem.writeFile("/workspace/fixture.txt", "1234");
    expect(
      await view.fileSystem.readFile("/workspace/fixture.txt", "utf8")
    ).toBe("1234");
  });

  test("releases a failed append reservation", async () => {
    const view = await openReadView();
    const append = spyOn(OverlayFs.prototype, "appendFile");
    append.mockImplementationOnce(() =>
      Promise.reject(new Error("EIO: simulated append failure"))
    );

    try {
      await expect(
        view.fileSystem.appendFile("/workspace/fixture.txt", "1234")
      ).rejects.toThrow("simulated append failure");
    } finally {
      append.mockRestore();
    }

    await view.fileSystem.appendFile("/workspace/fixture.txt", "1234");
    expect(
      await view.fileSystem.readFile("/workspace/fixture.txt", "utf8")
    ).toBe("1234");
  });

  test("releases a failed chmod reservation", async () => {
    await writeFile(join(servedPath, "fixture.txt"), "1234");
    const view = await openReadView();
    const chmod = spyOn(OverlayFs.prototype, "chmod");
    chmod.mockImplementationOnce(() =>
      Promise.reject(new Error("EIO: simulated chmod failure"))
    );

    try {
      await expect(
        view.fileSystem.chmod("/workspace/fixture.txt", 0o600)
      ).rejects.toThrow("simulated chmod failure");
    } finally {
      chmod.mockRestore();
    }

    await view.fileSystem.writeFile("/workspace/other.txt", "1234");
    expect(await view.fileSystem.readFile("/workspace/other.txt", "utf8")).toBe(
      "1234"
    );
  });

  test("releases a failed timestamp reservation", async () => {
    await writeFile(join(servedPath, "fixture.txt"), "1234");
    const view = await openReadView();
    const utimes = spyOn(OverlayFs.prototype, "utimes");
    utimes.mockImplementationOnce(() =>
      Promise.reject(new Error("EIO: simulated timestamp failure"))
    );

    try {
      await expect(
        view.fileSystem.utimes(
          "/workspace/fixture.txt",
          new Date(0),
          new Date(0)
        )
      ).rejects.toThrow("simulated timestamp failure");
    } finally {
      utimes.mockRestore();
    }

    await view.fileSystem.writeFile("/workspace/other.txt", "1234");
    expect(await view.fileSystem.readFile("/workspace/other.txt", "utf8")).toBe(
      "1234"
    );
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
