import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
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

describe("ServedRoot", () => {
  test("canonicalizes an alias before exposing its path", async () => {
    const alias = join(fixtureRoot, "alias");
    await writeFile(join(servedPath, "marker.txt"), "served marker\n");
    await symlink(
      servedPath,
      alias,
      process.platform === "win32" ? "junction" : "dir"
    );

    const root = await Effect.runPromise(ServedRoot.make(alias));
    await Effect.runPromise(root.verify());

    expect(root.path).not.toBe(alias);
    expect(await readFile(join(root.path, "marker.txt"), "utf8")).toBe(
      "served marker\n"
    );
  });

  test("keeps accepting live changes within the same directory", async () => {
    const root = await Effect.runPromise(ServedRoot.make(servedPath));
    await writeFile(join(servedPath, "uncommitted.txt"), "live\n");

    await Effect.runPromise(root.verify());

    expect(await readFile(join(root.path, "uncommitted.txt"), "utf8")).toBe(
      "live\n"
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
