import { createHash } from "node:crypto";
import { promises as hostFileSystem } from "node:fs";
import { lstat, mkdir, mkdtemp, open, rmdir } from "node:fs/promises";
import { dirname, join, posix, resolve, win32 } from "node:path";
import { Effect, Exit, Schema, Stream } from "effect";
import { publishPathNoReplace } from "../files/atomic-publish";
import {
  type ServedRoot,
  ServedRootChangedError,
  ServedRootEntryTypeError,
  ServedRootFileLimitError,
  ServedRootIOError,
  ServedRootNotFoundError,
  ServedRootPathError,
  type ServedRootPullView,
  ServedRootSourceChangedError,
  ServedRootSymlinkError,
  type SourceEntry,
  type SourceRevision,
} from "../files/served-root";

const digestPattern = /^[0-9a-f]{64}$/;
const windowsDrivePattern = /^[a-z]:/i;
const windowsForbiddenComponentPattern = /[<>:"|?*]/;
const windowsReservedBasePattern =
  /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])$/i;
const FileEntrySchema = Schema.Struct({
  digest: Schema.String,
  kind: Schema.Literal("file"),
  path: Schema.String,
  size: Schema.Number,
});

const DirectoryEntrySchema = Schema.Struct({
  kind: Schema.Literal("directory"),
  path: Schema.String,
});

export const PullManifestSchema = Schema.Struct({
  digestAlgorithm: Schema.Literal("sha256"),
  entries: Schema.Array(Schema.Union([FileEntrySchema, DirectoryEntrySchema])),
  kind: Schema.Union([Schema.Literal("file"), Schema.Literal("directory")]),
  name: Schema.String,
  totalBytes: Schema.Number,
});

export type PullManifest = Schema.Schema.Type<typeof PullManifestSchema>;
export type PullManifestEntry = PullManifest["entries"][number];
export type PullFileEntry = Extract<
  PullManifestEntry,
  { readonly kind: "file" }
>;

export interface PullLimits {
  readonly chunkBytes: number;
  readonly maxEntries: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
}

export interface PullSource {
  readonly manifest: PullManifest;
  readonly read: PullRead;
  readonly verify: Effect.Effect<void, PullError>;
}

export type PullRead = (
  entry: PullFileEntry,
  signal: AbortSignal
) => Stream.Stream<Uint8Array, PullError>;

export interface PullResult {
  readonly bytes: number;
  readonly files: number;
}

export class PullPathError extends Schema.TaggedErrorClass<PullPathError>()(
  "PullPathError",
  {
    path: Schema.String,
    reason: Schema.String,
  }
) {}

export class PullNotFoundError extends Schema.TaggedErrorClass<PullNotFoundError>()(
  "PullNotFoundError",
  { path: Schema.String }
) {}

export class PullSymlinkError extends Schema.TaggedErrorClass<PullSymlinkError>()(
  "PullSymlinkError",
  { path: Schema.String }
) {}

export class PullLimitError extends Schema.TaggedErrorClass<PullLimitError>()(
  "PullLimitError",
  {
    limit: Schema.String,
    maximum: Schema.Number,
    observed: Schema.Number,
  }
) {}

export class PullRemoteLimitError extends Schema.TaggedErrorClass<PullRemoteLimitError>()(
  "PullRemoteLimitError",
  { path: Schema.String }
) {}

export class PullSourceChangedError extends Schema.TaggedErrorClass<PullSourceChangedError>()(
  "PullSourceChangedError",
  { path: Schema.String }
) {}

export class PullDestinationExistsError extends Schema.TaggedErrorClass<PullDestinationExistsError>()(
  "PullDestinationExistsError",
  { path: Schema.String }
) {}

export class PullIntegrityError extends Schema.TaggedErrorClass<PullIntegrityError>()(
  "PullIntegrityError",
  {
    actual: Schema.String,
    expected: Schema.String,
    path: Schema.String,
  }
) {}

export class PullIOError extends Schema.TaggedErrorClass<PullIOError>()(
  "PullIOError",
  {
    operation: Schema.String,
    path: Schema.String,
  }
) {}

export type PullError =
  | PullPathError
  | PullNotFoundError
  | PullSymlinkError
  | PullLimitError
  | PullRemoteLimitError
  | PullSourceChangedError
  | PullDestinationExistsError
  | PullIntegrityError
  | PullIOError
  | ServedRootChangedError;

interface PlannedFile {
  readonly displayPath: string;
  readonly entry: PullFileEntry;
  readonly revision: SourceRevision;
  readonly view: ServedRootPullView;
}

interface PlannedDirectory {
  readonly children: readonly string[];
  readonly displayPath: string;
  readonly revision: SourceRevision;
}

const defaultLimits: PullLimits = {
  chunkBytes: 64 * 1024,
  maxEntries: 4096,
  maxFileBytes: 1024 * 1024 * 1024,
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
};

const compareText = (left: string, right: string) => {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
};

const isPullError = (cause: unknown): cause is PullError =>
  cause instanceof PullPathError ||
  cause instanceof PullNotFoundError ||
  cause instanceof PullSymlinkError ||
  cause instanceof PullLimitError ||
  cause instanceof PullRemoteLimitError ||
  cause instanceof PullSourceChangedError ||
  cause instanceof PullDestinationExistsError ||
  cause instanceof PullIntegrityError ||
  cause instanceof PullIOError ||
  cause instanceof ServedRootChangedError;

const hasCode = (cause: unknown, code: string) =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  cause.code === code;

const mapPullError = (
  cause: unknown,
  operation: string,
  path: string
): PullError => {
  if (isPullError(cause)) {
    return cause;
  }
  if (cause instanceof ServedRootPathError) {
    return new PullPathError({ path: cause.path, reason: cause.reason });
  }
  if (cause instanceof ServedRootNotFoundError) {
    return new PullNotFoundError({ path: cause.path });
  }
  if (cause instanceof ServedRootSymlinkError) {
    return new PullSymlinkError({ path: cause.path });
  }
  if (cause instanceof ServedRootEntryTypeError) {
    return new PullPathError({
      path: cause.path,
      reason:
        cause.expected === "file" ? "not a regular file" : "not a directory",
    });
  }
  if (cause instanceof ServedRootSourceChangedError) {
    return changed(cause.path);
  }
  if (cause instanceof ServedRootFileLimitError) {
    return new PullLimitError({
      limit: "file bytes",
      maximum: cause.maximum,
      observed: cause.observed,
    });
  }
  if (cause instanceof ServedRootIOError) {
    return new PullIOError({
      operation: cause.operation,
      path: cause.path,
    });
  }
  return new PullIOError({ operation, path });
};

const limitsFrom = (input: Partial<PullLimits> | undefined): PullLimits => {
  const limits = { ...defaultLimits, ...input };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new PullLimitError({
        limit: name,
        maximum: value,
        observed: value,
      });
    }
  }
  return limits;
};

const pathParts = (path: string) => {
  if (
    path.length === 0 ||
    path.includes("\0") ||
    path.includes("\\") ||
    posix.isAbsolute(path) ||
    windowsDrivePattern.test(path) ||
    win32.isAbsolute(path)
  ) {
    throw new PullPathError({
      path,
      reason: "path must be canonical and relative",
    });
  }

  const parts = path.split("/");
  if (
    parts.some((part) => {
      const windowsBase = part.split(".", 1)[0]?.trimEnd() ?? "";
      return (
        part.length === 0 ||
        part === "." ||
        part === ".." ||
        part.endsWith(".") ||
        part.endsWith(" ") ||
        Array.from(part).some((character) => character.charCodeAt(0) < 32) ||
        windowsForbiddenComponentPattern.test(part) ||
        windowsReservedBasePattern.test(windowsBase)
      );
    })
  ) {
    throw new PullPathError({
      path,
      reason: "path must be canonical and relative",
    });
  }
  return parts;
};

export const resolvePullDestination = (
  remotePath: string,
  destination?: string
): string => {
  const parts = pathParts(remotePath);
  if (destination !== undefined) {
    return destination;
  }

  const name = parts.at(-1);
  if (!name) {
    throw new PullPathError({
      path: remotePath,
      reason: "path has no file name",
    });
  }
  return `./${name}`;
};

const fileLimit = (size: number, limits: PullLimits) => {
  if (!Number.isSafeInteger(size) || size < 0 || size > limits.maxFileBytes) {
    throw new PullLimitError({
      limit: "file bytes",
      maximum: limits.maxFileBytes,
      observed: size,
    });
  }
};

const entryLimit = (count: number, limits: PullLimits) => {
  if (count > limits.maxEntries) {
    throw new PullLimitError({
      limit: "entries",
      maximum: limits.maxEntries,
      observed: count,
    });
  }
};

const totalLimit = (total: number, limits: PullLimits) => {
  if (!Number.isSafeInteger(total) || total > limits.maxTotalBytes) {
    throw new PullLimitError({
      limit: "total bytes",
      maximum: limits.maxTotalBytes,
      observed: total,
    });
  }
};

const changed = (path: string): PullSourceChangedError =>
  new PullSourceChangedError({ path });

const planSourceFile = async (options: {
  readonly displayPath: string;
  readonly limits: PullLimits;
  readonly signal: AbortSignal;
  readonly view: ServedRootPullView;
}) => {
  const scanner = options.view.scan({
    chunkBytes: options.limits.chunkBytes,
    maxFileBytes: options.limits.maxFileBytes,
    path: options.displayPath,
    signal: options.signal,
  });
  let result = await scanner.next();
  while (!result.done) {
    // biome-ignore lint/performance/noAwaitInLoops: Planning must consume the stable file scan fully.
    result = await scanner.next();
  }
  return result.value;
};

const streamPlannedFile = (
  file: PlannedFile,
  limits: PullLimits,
  signal: AbortSignal
): Stream.Stream<Uint8Array, PullError> =>
  Stream.fromAsyncIterable(
    file.view.scan({
      chunkBytes: limits.chunkBytes,
      expected: {
        digest: file.entry.digest,
        revision: file.revision,
        size: file.entry.size,
      },
      maxFileBytes: limits.maxFileBytes,
      path: file.displayPath,
      signal,
    }),
    (cause) => mapPullError(cause, "stream source file", file.displayPath)
  );

const sameNames = (actual: readonly string[], expected: readonly string[]) =>
  actual.length === expected.length &&
  actual.every((name, index) => name === expected[index]);

const verifyPullSourcePromise = async (options: {
  readonly directories: ReadonlyMap<string, PlannedDirectory>;
  readonly files: ReadonlyMap<string, PlannedFile>;
  readonly limits: PullLimits;
  readonly manifest: PullManifest;
  readonly servedRoot: ServedRoot;
  readonly signal: AbortSignal;
}) => {
  options.signal.throwIfAborted();
  await Effect.runPromise(options.servedRoot.verify());
  options.signal.throwIfAborted();
  const view = options.servedRoot.openPullView();

  let discoveredEntries = 0;
  let recheckedEntries = 0;
  let totalBytes = 0;
  const reserveEntry = () => {
    discoveredEntries += 1;
    entryLimit(discoveredEntries, options.limits);
  };
  const reserveRecheckEntry = () => {
    recheckedEntries += 1;
    entryLimit(recheckedEntries, options.limits);
  };

  const verifyFile = async (file: PlannedFile) => {
    options.signal.throwIfAborted();
    const entry = await view.inspect(
      file.displayPath,
      { expected: file.revision },
      options.signal
    );
    if (entry.kind !== "file") {
      throw changed(file.displayPath);
    }
    fileLimit(entry.size, options.limits);
    totalBytes += entry.size;
    totalLimit(totalBytes, options.limits);
  };

  const verifyDirectory = async (
    relativePath: string,
    planned: PlannedDirectory
  ): Promise<void> => {
    options.signal.throwIfAborted();
    const listed = await view.list(
      planned.displayPath,
      {
        reserve: reserveEntry,
      },
      options.signal
    );
    if (!sameNames(listed.children, planned.children)) {
      throw changed(planned.displayPath);
    }
    const currentDirectory = await view.inspect(
      planned.displayPath,
      { expected: planned.revision },
      options.signal
    );
    if (currentDirectory.kind !== "directory") {
      throw changed(planned.displayPath);
    }

    for (const childName of listed.children) {
      options.signal.throwIfAborted();
      const entryPath = relativePath
        ? `${relativePath}/${childName}`
        : childName;
      const directory = options.directories.get(entryPath);
      if (directory) {
        // biome-ignore lint/performance/noAwaitInLoops: Planned entries are verified in deterministic order.
        await verifyDirectory(entryPath, directory);
        continue;
      }
      const file = options.files.get(entryPath);
      if (!file) {
        throw changed(`${planned.displayPath}/${childName}`);
      }
      await verifyFile(file);
    }

    const rechecked = await view.list(
      planned.displayPath,
      {
        reserve: reserveRecheckEntry,
      },
      options.signal
    );
    if (!sameNames(rechecked.children, planned.children)) {
      throw changed(planned.displayPath);
    }
    const recheckedDirectory = await view.inspect(
      planned.displayPath,
      { expected: planned.revision },
      options.signal
    );
    if (recheckedDirectory.kind !== "directory") {
      throw changed(planned.displayPath);
    }
  };

  if (options.manifest.kind === "file") {
    reserveEntry();
    const file = options.files.get(options.manifest.name);
    if (!file) {
      throw changed(options.manifest.name);
    }
    await verifyFile(file);
  } else {
    const rootDirectory = options.directories.get("");
    if (!rootDirectory) {
      throw changed(options.manifest.name);
    }
    await verifyDirectory("", rootDirectory);
  }

  if (totalBytes !== options.manifest.totalBytes) {
    throw changed(options.manifest.name);
  }
  await Effect.runPromise(options.servedRoot.verify());
  options.signal.throwIfAborted();
};

const preparePullPromise = async (
  options: {
    readonly limits?: Partial<PullLimits>;
    readonly remotePath: string;
    readonly servedRoot: ServedRoot;
  },
  prepareSignal: AbortSignal
): Promise<PullSource> => {
  prepareSignal.throwIfAborted();
  const limits = limitsFrom(options.limits);
  const parts = pathParts(options.remotePath);
  await Effect.runPromise(options.servedRoot.verify());
  prepareSignal.throwIfAborted();
  const view = options.servedRoot.openPullView();
  const target = await view.inspect(options.remotePath, {}, prepareSignal);

  const entries: PullManifestEntry[] = [];
  const directories = new Map<string, PlannedDirectory>();
  const files = new Map<string, PlannedFile>();
  let discoveredEntries = 0;
  let totalBytes = 0;

  const reserveEntry = () => {
    const nextCount = discoveredEntries + 1;
    entryLimit(nextCount, limits);
    discoveredEntries = nextCount;
  };

  const addFile = async (
    entryPath: string,
    displayPath: string,
    observed: Extract<SourceEntry, { readonly kind: "file" }>
  ) => {
    fileLimit(observed.size, limits);
    totalLimit(totalBytes + observed.size, limits);
    const planned = await planSourceFile({
      displayPath,
      limits,
      signal: prepareSignal,
      view,
    });
    const entry: PullFileEntry = {
      digest: planned.digest,
      kind: "file",
      path: entryPath,
      size: planned.size,
    };
    entries.push(entry);
    const nextTotal = totalBytes + entry.size;
    totalLimit(nextTotal, limits);
    totalBytes = nextTotal;
    files.set(entry.path, {
      displayPath,
      entry,
      revision: planned.revision,
      view,
    });
  };

  const walk = async (
    relativeDirectory: string,
    displayDirectory: string,
    observed: Extract<SourceEntry, { readonly kind: "directory" }>
  ): Promise<void> => {
    const listed = await view.list(
      displayDirectory,
      {
        expected: observed.revision,
        reserve: reserveEntry,
      },
      prepareSignal
    );
    directories.set(relativeDirectory, {
      children: listed.children,
      displayPath: displayDirectory,
      revision: listed.revision,
    });

    for (const childName of listed.children) {
      prepareSignal.throwIfAborted();
      const entryPath = relativeDirectory
        ? `${relativeDirectory}/${childName}`
        : childName;
      const displayPath = `${displayDirectory}/${childName}`;
      pathParts(entryPath);
      // biome-ignore lint/performance/noAwaitInLoops: Tree entries are planned in deterministic order.
      const child = await view.inspect(displayPath, {}, prepareSignal);
      if (child.kind === "directory") {
        entries.push({ kind: "directory", path: entryPath });
        await walk(entryPath, displayPath, child);
      } else if (child.kind === "file") {
        await addFile(entryPath, displayPath, child);
      } else {
        throw new PullPathError({
          path: displayPath,
          reason: "not a regular file or directory",
        });
      }
    }
  };

  const manifestName = parts.at(-1);
  if (!manifestName) {
    throw new PullPathError({
      path: options.remotePath,
      reason: "path has no file name",
    });
  }

  let kind: PullManifest["kind"];
  if (target.kind === "file") {
    kind = "file";
    reserveEntry();
    await addFile(manifestName, options.remotePath, target);
  } else if (target.kind === "directory") {
    kind = "directory";
    await walk("", options.remotePath, target);
  } else {
    throw new PullPathError({
      path: options.remotePath,
      reason: "not a regular file or directory",
    });
  }

  entries.sort((left, right) => compareText(left.path, right.path));
  const manifest: PullManifest = {
    digestAlgorithm: "sha256",
    entries,
    kind,
    name: manifestName,
    totalBytes,
  };
  await Effect.runPromise(options.servedRoot.verify());
  prepareSignal.throwIfAborted();

  return {
    manifest,
    read: (entry, signal) => {
      const file = files.get(entry.path);
      if (
        !file ||
        file.entry.digest !== entry.digest ||
        file.entry.size !== entry.size
      ) {
        return Stream.fail(changed(entry.path));
      }
      return streamPlannedFile(file, limits, signal);
    },
    verify: Effect.tryPromise({
      catch: (cause) =>
        mapPullError(cause, "verify pull source", options.remotePath),
      try: (signal) =>
        verifyPullSourcePromise({
          directories,
          files,
          limits,
          manifest,
          servedRoot: options.servedRoot,
          signal,
        }),
    }),
  };
};

const decodeManifest = Schema.decodeUnknownSync(PullManifestSchema);

const manifestFrom = (input: unknown, limits: PullLimits): PullManifest => {
  let manifest: PullManifest;
  try {
    manifest = decodeManifest(input);
  } catch {
    // biome-ignore lint/style/useErrorCause: Decoder details are not part of the wire error.
    throw new PullIntegrityError({
      actual: "invalid manifest",
      expected: "valid manifest",
      path: "manifest",
    });
  }

  const nameParts = pathParts(manifest.name);
  if (nameParts.length !== 1) {
    throw new PullPathError({
      path: manifest.name,
      reason: "manifest name must have one component",
    });
  }
  entryLimit(manifest.entries.length, limits);

  const directories = new Set<string>();
  const paths = new Set<string>();
  let totalBytes = 0;
  let previousPath = "";
  for (const entry of manifest.entries) {
    const parts = pathParts(entry.path);
    if (paths.has(entry.path) || compareText(previousPath, entry.path) >= 0) {
      throw new PullIntegrityError({
        actual: entry.path,
        expected: "unique entries in lexical order",
        path: "manifest",
      });
    }
    paths.add(entry.path);
    previousPath = entry.path;

    const parentParts = parts.slice(0, -1);
    for (let index = 1; index <= parentParts.length; index += 1) {
      const parent = parentParts.slice(0, index).join("/");
      if (!directories.has(parent)) {
        throw new PullIntegrityError({
          actual: entry.path,
          expected: `declared parent directory ${parent}`,
          path: "manifest",
        });
      }
    }

    if (entry.kind === "directory") {
      directories.add(entry.path);
      continue;
    }
    fileLimit(entry.size, limits);
    if (!digestPattern.test(entry.digest)) {
      throw new PullIntegrityError({
        actual: entry.digest,
        expected: "lowercase sha256 digest",
        path: entry.path,
      });
    }
    totalBytes += entry.size;
    totalLimit(totalBytes, limits);
  }

  if (manifest.totalBytes !== totalBytes) {
    throw new PullIntegrityError({
      actual: String(manifest.totalBytes),
      expected: String(totalBytes),
      path: "manifest",
    });
  }
  if (
    manifest.kind === "file" &&
    (manifest.entries.length !== 1 ||
      manifest.entries[0]?.kind !== "file" ||
      manifest.entries[0].path !== manifest.name)
  ) {
    throw new PullIntegrityError({
      actual: "invalid file manifest",
      expected: "one named file entry",
      path: "manifest",
    });
  }

  return manifest;
};

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
  readonly manifest: unknown;
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

export const preparePull = Effect.fn("PullTransfer.prepare")(
  (options: {
    readonly limits?: Partial<PullLimits>;
    readonly remotePath: string;
    readonly servedRoot: ServedRoot;
  }) =>
    Effect.tryPromise({
      catch: (cause) => mapPullError(cause, "prepare pull", options.remotePath),
      try: (signal) => preparePullPromise(options, signal),
    })
);

export const materializePull = Effect.fn("PullTransfer.materialize")(
  (options: {
    readonly destination: string;
    readonly limits?: Partial<PullLimits>;
    readonly manifest: unknown;
    readonly read: PullRead;
  }) => materializePullEffect(options)
);
