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
  linuxLibraryCandidates,
  linuxRenameat2SyscallNumber,
  publishPathNoReplace,
} from "../src/files/atomic-publish";

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

describe("atomic path publication", () => {
  test("maps supported glibc and musl runtimes without guessing an ABI", () => {
    expect(linuxLibraryCandidates("x64")).toEqual([
      "libc.so.6",
      "/lib/libc.musl-x86_64.so.1",
      "/lib/ld-musl-x86_64.so.1",
    ]);
    expect(linuxLibraryCandidates("arm64")).toEqual([
      "libc.so.6",
      "/lib/libc.musl-aarch64.so.1",
      "/lib/ld-musl-aarch64.so.1",
    ]);
    expect(linuxLibraryCandidates("riscv64")).toEqual(["libc.so.6"]);
    expect(linuxRenameat2SyscallNumber("x64")).toBe(316);
    expect(linuxRenameat2SyscallNumber("arm64")).toBe(276);
    expect(linuxRenameat2SyscallNumber("riscv64")).toBeUndefined();
  });

  test("distinguishes publication, destination conflicts, and native IO failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "dumbridge-publish-test-"));
    const destination = join(root, "destination");
    const firstSource = join(root, "first-source");
    const secondSource = join(root, "second-source");
    await Promise.all([mkdir(firstSource), mkdir(secondSource)]);

    try {
      expect(publishPathNoReplace(firstSource, destination)).toEqual({
        status: "published",
      });
      expect(await pathExists(firstSource)).toBe(false);
      expect(publishPathNoReplace(secondSource, destination).status).toBe(
        "destination-exists"
      );
      expect(await readdir(destination)).toEqual([]);
      expect(
        publishPathNoReplace(join(root, "missing"), join(root, "other")).status
      ).toBe("io-error");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("moves a staged file without leaving a writable source alias", async () => {
    const root = await mkdtemp(join(tmpdir(), "dumbridge-publish-test-"));
    const source = join(root, "source");
    const destination = join(root, "destination");
    await writeFile(source, "incoming");

    try {
      expect(publishPathNoReplace(source, destination)).toEqual({
        status: "published",
      });
      expect(await pathExists(source)).toBe(false);
      expect(await readFile(destination, "utf8")).toBe("incoming");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("preserves an existing file destination", async () => {
    const root = await mkdtemp(join(tmpdir(), "dumbridge-publish-test-"));
    const source = join(root, "source");
    const destination = join(root, "destination");
    await Promise.all([
      writeFile(source, "incoming"),
      writeFile(destination, "keep"),
    ]);

    try {
      expect(publishPathNoReplace(source, destination).status).toBe(
        "destination-exists"
      );
      expect(await readFile(source, "utf8")).toBe("incoming");
      expect(await readFile(destination, "utf8")).toBe("keep");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
