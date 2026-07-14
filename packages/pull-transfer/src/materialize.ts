import { createHash } from "node:crypto";
import { promises as hostFileSystem } from "node:fs";
import { lstat, mkdir, mkdtemp, open, rmdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Effect, Exit, Stream } from "effect";
import { publishPathNoReplace } from "./atomic-publish";
import {
  hasCode,
  mapPullError,
  PullDestinationExistsError,
  type PullError,
  PullIntegrityError,
  PullIOError,
  PullLimitError,
} from "./errors";
import {
  limitsFrom,
  manifestFrom,
  type PullFileEntry,
  type PullLimits,
  type PullManifest,
  type PullRead,
  type PullResult,
} from "./model";

const fsEffect = <A>(
  operation: string,
  path: string,
  run: () => PromiseLike<A>
): Effect.Effect<A, PullError> =>
  Effect.tryPromise({
    catch: (cause) => mapPullError(cause, operation, path),
    try: run,
  });

const destinationExists = (path: string): Effect.Effect<boolean, PullError> =>
  Effect.tryPromise({
    catch: (cause) => mapPullError(cause, "inspect destination", path),
    try: async () => {
      try {
        await lstat(path);
        return true;
      } catch (cause) {
        if (hasCode(cause, "ENOENT")) {
          return false;
        }
        throw cause;
      }
    },
  });

const removeEmptyParents = async (paths: readonly string[]) => {
  for (const path of [...paths].reverse()) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: Children must be removed before their parents.
      await rmdir(path);
    } catch (cause) {
      if (
        hasCode(cause, "ENOENT") ||
        hasCode(cause, "ENOTEMPTY") ||
        hasCode(cause, "EEXIST")
      ) {
        continue;
      }
      throw cause;
    }
  }
};

const findMissingParents = async (path: string): Promise<string[]> => {
  try {
    await lstat(path);
    return [];
  } catch (cause) {
    if (!hasCode(cause, "ENOENT")) {
      throw cause;
    }
    const ancestor = dirname(path);
    if (ancestor === path) {
      throw cause;
    }
    return [...(await findMissingParents(ancestor)), path];
  }
};

const createParent = async (path: string) => {
  try {
    await mkdir(path);
    return true;
  } catch (cause) {
    if (!hasCode(cause, "EEXIST")) {
      throw cause;
    }
    const stats = await lstat(path);
    if (!stats.isDirectory()) {
      throw cause;
    }
    return false;
  }
};

const createMissingParents = async (paths: readonly string[]) => {
  const created: string[] = [];
  try {
    for (const path of paths) {
      // biome-ignore lint/performance/noAwaitInLoops: Parents must exist before their children.
      if (await createParent(path)) {
        created.push(path);
      }
    }
    return created;
  } catch (cause) {
    await removeEmptyParents(created);
    throw cause;
  }
};

const prepareDestination = (
  parent: string
): Effect.Effect<readonly string[], PullError> =>
  fsEffect("create destination parent", parent, async () =>
    createMissingParents(await findMissingParents(parent))
  );

const removeCreatedParents = (
  paths: readonly string[],
  parent: string
): Effect.Effect<void, PullError> =>
  fsEffect("remove destination parents", parent, () =>
    removeEmptyParents(paths)
  );

const writeChunk = (
  handle: Awaited<ReturnType<typeof open>>,
  chunk: Uint8Array,
  path: string
): Effect.Effect<void, PullError> =>
  fsEffect("write staged file", path, async () => {
    let offset = 0;
    while (offset < chunk.byteLength) {
      // biome-ignore lint/performance/noAwaitInLoops: Partial writes must preserve byte order.
      const { bytesWritten } = await handle.write(
        chunk,
        offset,
        chunk.byteLength - offset
      );
      if (bytesWritten === 0) {
        throw new PullIOError({
          operation: "write staged file",
          path,
        });
      }
      offset += bytesWritten;
    }
  });

const writeEntry = (
  target: string,
  entry: PullFileEntry,
  limits: PullLimits,
  read: PullRead,
  signal: AbortSignal
): Effect.Effect<void, PullError> =>
  Effect.acquireUseRelease(
    fsEffect("open staged file", entry.path, () => open(target, "wx", 0o600)),
    (handle) =>
      Effect.gen(function* () {
        const stream = yield* Effect.try({
          catch: (cause) => mapPullError(cause, "open pull stream", entry.path),
          try: () => read(entry, signal),
        });
        const hash = createHash("sha256");
        let bytes = 0;

        yield* Stream.runForEach(
          stream.pipe(
            Stream.mapError((cause) =>
              mapPullError(cause, "read pull stream", entry.path)
            )
          ),
          (chunk): Effect.Effect<void, PullError> => {
            if (!(chunk instanceof Uint8Array)) {
              return new PullIntegrityError({
                actual: typeof chunk,
                expected: "Uint8Array",
                path: entry.path,
              });
            }
            if (chunk.byteLength > limits.chunkBytes) {
              return new PullLimitError({
                limit: "chunk bytes",
                maximum: limits.chunkBytes,
                observed: chunk.byteLength,
              });
            }
            bytes += chunk.byteLength;
            if (bytes > entry.size) {
              return new PullIntegrityError({
                actual: String(bytes),
                expected: String(entry.size),
                path: entry.path,
              });
            }
            hash.update(chunk);
            return writeChunk(handle, chunk, entry.path);
          }
        );

        const digest = hash.digest("hex");
        if (bytes !== entry.size || digest !== entry.digest) {
          return yield* new PullIntegrityError({
            actual: `${bytes}:${digest}`,
            expected: `${entry.size}:${entry.digest}`,
            path: entry.path,
          });
        }
      }),
    (handle) =>
      fsEffect("close staged file", entry.path, () => handle.close()).pipe(
        Effect.asVoid
      )
  );

const commitPath = (
  payload: string,
  destination: string
): Effect.Effect<void, PullError> =>
  Effect.gen(function* () {
    const result = yield* Effect.try({
      catch: () =>
        new PullIOError({
          operation: "commit destination",
          path: destination,
        }),
      try: () => publishPathNoReplace(payload, destination),
    });
    if (result.status === "published") {
      return;
    }
    if (result.status === "destination-exists") {
      return yield* new PullDestinationExistsError({ path: destination });
    }
    if (result.status === "unsupported") {
      return yield* new PullIOError({
        operation: "atomic path publication unavailable",
        path: destination,
      });
    }
    return yield* new PullIOError({
      operation: "commit destination",
      path: destination,
    });
  });

const populateStage = (options: {
  readonly destination: string;
  readonly limits: PullLimits;
  readonly manifest: PullManifest;
  readonly read: PullRead;
  readonly signal: AbortSignal;
  readonly stage: string;
}): Effect.Effect<PullResult, PullError> =>
  Effect.gen(function* () {
    const payload = join(options.stage, "payload");
    if (options.manifest.kind === "directory") {
      yield* fsEffect("create staged directory", options.destination, () =>
        mkdir(payload)
      );
    }

    let files = 0;
    for (const entry of options.manifest.entries) {
      const target =
        options.manifest.kind === "file"
          ? payload
          : join(payload, ...entry.path.split("/"));
      if (entry.kind === "directory") {
        yield* fsEffect("create staged directory", entry.path, () =>
          mkdir(target)
        );
      } else {
        yield* fsEffect("create staged parent", entry.path, () =>
          mkdir(dirname(target), { recursive: true })
        );
        yield* writeEntry(
          target,
          entry,
          options.limits,
          options.read,
          options.signal
        );
        files += 1;
      }
    }

    yield* commitPath(payload, options.destination);
    return { bytes: options.manifest.totalBytes, files };
  });

const materializePullEffect = (options: {
  readonly destination: string;
  readonly limits?: Partial<PullLimits>;
  readonly manifest: PullManifest;
  readonly read: PullRead;
}): Effect.Effect<PullResult, PullError> =>
  Effect.gen(function* () {
    const limits = yield* Effect.try({
      catch: (cause) =>
        mapPullError(cause, "validate pull limits", options.destination),
      try: () => limitsFrom(options.limits),
    });
    const manifest = yield* Effect.try({
      catch: (cause) =>
        mapPullError(cause, "validate pull manifest", options.destination),
      try: () => manifestFrom(options.manifest, limits),
    });
    const destination = resolve(options.destination);
    if (yield* destinationExists(destination)) {
      return yield* new PullDestinationExistsError({
        path: options.destination,
      });
    }

    const parent = dirname(destination);
    return yield* Effect.acquireUseRelease(
      prepareDestination(parent),
      () =>
        Effect.acquireUseRelease(
          fsEffect("create pull staging directory", destination, () =>
            mkdtemp(join(parent, ".dumbridge-pull-"))
          ),
          (stage) => {
            const controller = new AbortController();

            return Effect.acquireUseRelease(
              Effect.succeed(controller),
              ({ signal }) =>
                populateStage({
                  destination,
                  limits,
                  manifest,
                  read: options.read,
                  signal,
                  stage,
                }),
              (activeController) =>
                Effect.sync(() => {
                  activeController.abort();
                })
            );
          },
          (stage, exit) => {
            const cleanup = fsEffect(
              "remove pull staging directory",
              destination,
              () => hostFileSystem.rm(stage, { force: true, recursive: true })
            );
            return Exit.isSuccess(exit) ? cleanup.pipe(Effect.ignore) : cleanup;
          }
        ),
      (createdParents, exit) =>
        Exit.isSuccess(exit)
          ? Effect.void
          : removeCreatedParents(createdParents, parent)
    );
  });

export const materializePull = Effect.fn("PullTransfer.materialize")(
  (options: {
    readonly destination: string;
    readonly limits?: Partial<PullLimits>;
    readonly manifest: PullManifest;
    readonly read: PullRead;
  }) => materializePullEffect(options)
);
