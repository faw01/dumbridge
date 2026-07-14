import { describe, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  linuxLibcCandidates,
  linuxRenameat2SyscallNumber,
  movePathNoReplace,
} from "../src/pull/atomic-path-move";

const withFixture = async <A>(use: (root: string) => Promise<A>) => {
  const root = await mkdtemp(join(tmpdir(), "dumbridge-atomic-move-test-"));
  try {
    return await use(root);
  } finally {
    await rm(root, { force: true, recursive: true });
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

describe("atomic path move", () => {
  test("discovers glibc and supported musl library names", () => {
    expect(linuxLibcCandidates("x64")).toEqual([
      "libc.so.6",
      "/lib/libc.musl-x86_64.so.1",
      "/lib/ld-musl-x86_64.so.1",
    ]);
    expect(linuxLibcCandidates("arm64")).toEqual([
      "libc.so.6",
      "/lib/libc.musl-aarch64.so.1",
      "/lib/ld-musl-aarch64.so.1",
    ]);
    expect(linuxLibcCandidates("riscv64")).toEqual(["libc.so.6"]);
  });

  test("maps only supported Linux architectures to renameat2 syscalls", () => {
    expect(linuxRenameat2SyscallNumber("x64")).toBe(316);
    expect(linuxRenameat2SyscallNumber("arm64")).toBe(276);
    expect(linuxRenameat2SyscallNumber("riscv64")).toBeUndefined();
  });

  test("moves a staged directory when the destination is absent", () =>
    withFixture(async (root) => {
      const source = join(root, "stage");
      const destination = join(root, "destination");
      await mkdir(source);
      await writeFile(join(source, "incoming.txt"), "incoming");

      expect(movePathNoReplace(source, destination)).toBe(true);
      expect(await pathExists(source)).toBe(false);
      expect(await readFile(join(destination, "incoming.txt"), "utf8")).toBe(
        "incoming"
      );
    }));

  test("moves a staged file and removes its source path", () =>
    withFixture(async (root) => {
      const source = join(root, "stage");
      const destination = join(root, "destination");
      await writeFile(source, "incoming");

      expect(movePathNoReplace(source, destination)).toBe(true);
      expect(await pathExists(source)).toBe(false);
      expect(await readFile(destination, "utf8")).toBe("incoming");
    }));

  test("preserves a destination created at the commit seam", () =>
    withFixture(async (root) => {
      const source = join(root, "stage");
      const destination = join(root, "destination");
      await mkdir(source);
      await writeFile(join(source, "incoming.txt"), "incoming");

      await mkdir(destination);
      const destinationBefore = await lstat(destination);

      expect(movePathNoReplace(source, destination)).toBe(false);
      expect(await readFile(join(source, "incoming.txt"), "utf8")).toBe(
        "incoming"
      );
      expect(await readdir(destination)).toEqual([]);
      const destinationAfter = await lstat(destination);
      expect({
        birthtimeMs: destinationAfter.birthtimeMs,
        dev: destinationAfter.dev,
        ino: destinationAfter.ino,
      }).toEqual({
        birthtimeMs: destinationBefore.birthtimeMs,
        dev: destinationBefore.dev,
        ino: destinationBefore.ino,
      });
    }));

  test("preserves an existing file destination", () =>
    withFixture(async (root) => {
      const source = join(root, "stage");
      const destination = join(root, "destination");
      await writeFile(source, "incoming");
      await writeFile(destination, "keep");

      expect(movePathNoReplace(source, destination)).toBe(false);
      expect(await readFile(source, "utf8")).toBe("incoming");
      expect(await readFile(destination, "utf8")).toBe("keep");
    }));
});
