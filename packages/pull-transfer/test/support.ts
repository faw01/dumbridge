import { lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServedRoot } from "@dumbridge/served-root";
import { Effect, Stream } from "effect";
import type { PullSource } from "../src/index";

export const withFixture = async <A>(
  use: (fixture: {
    readonly root: string;
    readonly servedRoot: ServedRoot;
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
  const servedRoot = await Effect.runPromise(ServedRoot.make(root));

  try {
    return await use({ root, servedRoot, workspace });
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
};

export const collectError = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.flip(effect));

export const oneChunk = (chunk: Uint8Array) => Stream.make(chunk);

export const streamSource = async (source: PullSource) => {
  for (const entry of source.manifest.entries) {
    if (entry.kind === "file") {
      // biome-ignore lint/performance/noAwaitInLoops: Tests model the server's ordered transfer.
      await Effect.runPromise(
        Stream.runDrain(source.read(entry, new AbortController().signal))
      );
    }
  }
};

export const pathExists = async (path: string) => {
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

export const waitUntil = async (condition: () => boolean) => {
  const deadline = Date.now() + 1000;
  while (!condition() && Date.now() < deadline) {
    // biome-ignore lint/performance/noAwaitInLoops: Test polling yields to the source scan.
    await new Promise((resolveWait) => setTimeout(resolveWait, 1));
  }
};
