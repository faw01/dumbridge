import { lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServedRoot } from "@dumbridge/served-root";
import { Effect, Stream } from "effect";
import type { PullSource } from "../src/index";

type MakeServedRootError = Effect.Error<ReturnType<typeof ServedRoot.make>>;

export const withFixture = <A, E>(
  use: (fixture: {
    readonly root: string;
    readonly servedRoot: ServedRoot;
    readonly workspace: string;
  }) => Effect.Effect<A, E>
): Effect.Effect<A, E | MakeServedRootError> =>
  Effect.gen(function* () {
    const temporaryRoot = yield* Effect.promise(() =>
      mkdtemp(join(tmpdir(), "dumbridge-pull-test-"))
    );

    return yield* Effect.gen(function* () {
      const root = join(temporaryRoot, "served");
      const workspace = join(temporaryRoot, "workspace");
      yield* Effect.promise(() =>
        Promise.all([
          mkdir(root, { recursive: true }),
          mkdir(workspace, { recursive: true }),
        ])
      );
      const servedRoot = yield* ServedRoot.make(root);
      return yield* use({ root, servedRoot, workspace });
    }).pipe(
      Effect.ensuring(
        Effect.promise(() =>
          rm(temporaryRoot, { force: true, recursive: true })
        )
      )
    );
  });

export const oneChunk = (chunk: Uint8Array) => Stream.make(chunk);

export const streamSource = (source: PullSource) =>
  Effect.forEach(
    source.manifest.entries.filter((entry) => entry.kind === "file"),
    (entry) =>
      Stream.runDrain(source.read(entry, new AbortController().signal)),
    { discard: true }
  );

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
