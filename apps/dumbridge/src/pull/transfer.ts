import { createHash } from "node:crypto";
import { constants, type Dirent, type Stats } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  realpath,
  rm,
  rmdir,
} from "node:fs/promises";
import { dirname, join, posix, relative, resolve, sep, win32 } from "node:path";
import { Effect, Exit, Schema, Stream } from "effect";
import { moveDirectoryNoReplace } from "./atomic-directory-move";

const digestPattern = /^[0-9a-f]{64}$/;
const windowsDeviceNamePattern =
  /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/i;
const windowsDrivePattern = /^[a-z]:/i;
// biome-ignore lint/suspicious/noBitwiseOperators: POSIX open flags compose as a bitmask.
const readOnlyNoFollow = constants.O_RDONLY | constants.O_NOFOLLOW;

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
  | PullSourceChangedError
  | PullDestinationExistsError
  | PullIntegrityError
  | PullIOError;

interface Fingerprint {
  readonly ctimeMs: number;
  readonly dev: number;
  readonly ino: number;
  readonly mtimeMs: number;
  readonly size: number;
}

interface FileRevision {
  readonly digest: string;
  readonly fingerprint: Fingerprint;
  readonly size: number;
}

interface PlannedFile {
  readonly displayPath: string;
  readonly parts: readonly string[];
  readonly revision: FileRevision;
  readonly root: string;
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

const fingerprint = (stats: Stats): Fingerprint => ({
  ctimeMs: stats.ctimeMs,
  dev: stats.dev,
  ino: stats.ino,
  mtimeMs: stats.mtimeMs,
  size: stats.size,
});

const fingerprintsMatch = (left: Fingerprint, right: Fingerprint) =>
  left.ctimeMs === right.ctimeMs &&
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.mtimeMs === right.mtimeMs &&
  left.size === right.size;

const isPullError = (cause: unknown): cause is PullError =>
  cause instanceof PullPathError ||
  cause instanceof PullNotFoundError ||
  cause instanceof PullSymlinkError ||
  cause instanceof PullLimitError ||
  cause instanceof PullSourceChangedError ||
  cause instanceof PullDestinationExistsError ||
  cause instanceof PullIntegrityError ||
  cause instanceof PullIOError;

const hasCode = (cause: unknown, code: string) =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  cause.code === code;

const mapPullError = (
  cause: unknown,
  operation: string,
  path: string
): PullError =>
  isPullError(cause) ? cause : new PullIOError({ operation, path });

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
    parts.some(
      (part) =>
        part.length === 0 ||
        part === "." ||
        part === ".." ||
        part.includes(":") ||
        windowsDeviceNamePattern.test(part)
    )
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
  if (destination !== undefined) {
    return destination;
  }

  const parts = pathParts(remotePath);
  const name = parts.at(-1);
  if (!name) {
    throw new PullPathError({
      path: remotePath,
      reason: "path has no file name",
    });
  }
  return `./${name}`;
};

const pathInside = (root: string, path: string) => {
  const offset = relative(root, path);
  return (
    offset.length > 0 &&
    offset !== ".." &&
    !offset.startsWith(`..${sep}`) &&
    !win32.isAbsolute(offset)
  );
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

const lstatRemote = async (
  absolutePath: string,
  remotePath: string,
  sourceWasPlanned: boolean
) => {
  try {
    return await lstat(absolutePath);
  } catch (cause) {
    if (hasCode(cause, "ENOENT")) {
      throw sourceWasPlanned
        ? changed(remotePath)
        : new PullNotFoundError({ path: remotePath });
    }
    throw cause;
  }
};

const inspectSourcePath = async (
  root: string,
  parts: readonly string[],
  sourceWasPlanned = false
) => {
  let absolutePath = root;
  let stats: Stats | undefined;

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part) {
      throw new PullPathError({
        path: parts.join("/"),
        reason: "path must be canonical and relative",
      });
    }
    absolutePath = join(absolutePath, part);
    const remotePath = parts.slice(0, index + 1).join("/");
    // biome-ignore lint/performance/noAwaitInLoops: Every path component must be checked in order.
    stats = await lstatRemote(absolutePath, remotePath, sourceWasPlanned);
    if (stats.isSymbolicLink()) {
      throw new PullSymlinkError({ path: remotePath });
    }
  }

  if (!stats) {
    throw new PullPathError({
      path: parts.join("/"),
      reason: "path has no file name",
    });
  }

  return { absolutePath, stats };
};

const scanSourceFile = async function* (options: {
  readonly displayPath: string;
  readonly expected?: FileRevision;
  readonly limits: PullLimits;
  readonly parts: readonly string[];
  readonly root: string;
  readonly signal?: AbortSignal;
}): AsyncGenerator<Uint8Array, FileRevision> {
  try {
    const inspectedBefore = await inspectSourcePath(
      options.root,
      options.parts,
      options.expected !== undefined
    );
    const handle = await open(inspectedBefore.absolutePath, readOnlyNoFollow);
    try {
      const before = await handle.stat();
      if (!before.isFile()) {
        throw new PullPathError({
          path: options.displayPath,
          reason: "not a regular file",
        });
      }
      fileLimit(before.size, options.limits);

      const beforeFingerprint = fingerprint(before);
      if (
        !fingerprintsMatch(
          beforeFingerprint,
          fingerprint(inspectedBefore.stats)
        ) ||
        (options.expected !== undefined &&
          (!fingerprintsMatch(
            beforeFingerprint,
            options.expected.fingerprint
          ) ||
            before.size !== options.expected.size))
      ) {
        throw changed(options.displayPath);
      }

      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(options.limits.chunkBytes);
      let bytesRead = buffer.byteLength;
      let offset = 0;
      while (bytesRead > 0) {
        options.signal?.throwIfAborted();
        // biome-ignore lint/performance/noAwaitInLoops: File offsets are read sequentially.
        ({ bytesRead } = await handle.read(
          buffer,
          0,
          buffer.byteLength,
          offset
        ));
        if (bytesRead > 0) {
          const nextOffset = offset + bytesRead;
          fileLimit(nextOffset, options.limits);
          if (
            options.expected !== undefined &&
            nextOffset > options.expected.size
          ) {
            throw changed(options.displayPath);
          }
          options.signal?.throwIfAborted();
          const chunk = Uint8Array.from(buffer.subarray(0, bytesRead));
          hash.update(chunk);
          offset = nextOffset;
          yield chunk;
        }
      }

      const after = await handle.stat();
      const inspectedAfter = await inspectSourcePath(
        options.root,
        options.parts,
        options.expected !== undefined
      );
      const digest = hash.digest("hex");
      if (
        offset !== before.size ||
        !fingerprintsMatch(beforeFingerprint, fingerprint(after)) ||
        !fingerprintsMatch(
          beforeFingerprint,
          fingerprint(inspectedAfter.stats)
        ) ||
        (options.expected !== undefined &&
          (offset !== options.expected.size ||
            digest !== options.expected.digest))
      ) {
        throw changed(options.displayPath);
      }

      return {
        digest,
        fingerprint: beforeFingerprint,
        size: before.size,
      };
    } finally {
      await handle.close();
    }
  } catch (cause) {
    throw mapPullError(cause, "read source file", options.displayPath);
  }
};

const planSourceFile = async (options: {
  readonly displayPath: string;
  readonly limits: PullLimits;
  readonly parts: readonly string[];
  readonly root: string;
}) => {
  const scanner = scanSourceFile(options);
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
    scanSourceFile({
      displayPath: file.displayPath,
      expected: file.revision,
      limits,
      parts: file.parts,
      root: file.root,
      signal,
    }),
    (cause) => mapPullError(cause, "stream source file", file.displayPath)
  );

const readBoundedDirectory = async (
  absoluteDirectory: string,
  reserveEntry: () => void
): Promise<Dirent[]> => {
  const directory = await opendir(absoluteDirectory, { bufferSize: 1 });
  const children: Dirent[] = [];
  try {
    let child = await directory.read();
    while (child !== null) {
      reserveEntry();
      children.push(child);
      // biome-ignore lint/performance/noAwaitInLoops: Directory reads stop at the configured hard bound.
      child = await directory.read();
    }
  } finally {
    await directory.close();
  }

  children.sort((left, right) => compareText(left.name, right.name));
  return children;
};

const preparePullPromise = async (options: {
  readonly limits?: Partial<PullLimits>;
  readonly remotePath: string;
  readonly servedRoot: string;
}): Promise<PullSource> => {
  const limits = limitsFrom(options.limits);
  const parts = pathParts(options.remotePath);
  const root = await realpath(options.servedRoot);
  const rootStats = await lstat(root);
  if (!rootStats.isDirectory()) {
    throw new PullPathError({ path: "served root", reason: "not a directory" });
  }

  const target = resolve(root, ...parts);
  if (!pathInside(root, target)) {
    throw new PullPathError({
      path: options.remotePath,
      reason: "path escapes the served root",
    });
  }

  const inspectedTarget = await inspectSourcePath(root, parts);
  const targetStats = inspectedTarget.stats;

  const entries: PullManifestEntry[] = [];
  const files = new Map<string, PlannedFile>();
  let discoveredEntries = 0;
  let totalBytes = 0;

  const reserveEntry = () => {
    const nextCount = discoveredEntries + 1;
    entryLimit(nextCount, limits);
    discoveredEntries = nextCount;
  };

  const addFile = async (
    sourceParts: readonly string[],
    entryPath: string,
    displayPath: string
  ) => {
    const planned = await planSourceFile({
      displayPath,
      limits,
      parts: sourceParts,
      root,
    });
    const entry: PullFileEntry = {
      digest: planned.digest,
      kind: "file",
      path: entryPath,
      size: planned.size,
    };
    entries.push(entry);
    totalBytes += entry.size;
    totalLimit(totalBytes, limits);
    files.set(entry.path, {
      displayPath,
      parts: sourceParts,
      revision: planned,
      root,
    });
  };

  const walk = async (
    directoryParts: readonly string[],
    relativeDirectory: string,
    displayDirectory: string
  ): Promise<void> => {
    const absoluteDirectory = join(root, ...directoryParts);
    const children = await readBoundedDirectory(
      absoluteDirectory,
      reserveEntry
    );

    for (const child of children) {
      const entryPath = relativeDirectory
        ? `${relativeDirectory}/${child.name}`
        : child.name;
      const displayPath = `${displayDirectory}/${child.name}`;
      pathParts(entryPath);
      const sourceParts = [...directoryParts, child.name];
      // biome-ignore lint/performance/noAwaitInLoops: Tree entries are planned in deterministic order.
      const { stats } = await inspectSourcePath(root, sourceParts);
      if (stats.isDirectory()) {
        entries.push({ kind: "directory", path: entryPath });
        await walk(sourceParts, entryPath, displayPath);
      } else if (stats.isFile()) {
        await addFile(sourceParts, entryPath, displayPath);
      } else {
        throw new PullPathError({
          path: displayPath,
          reason: "not a regular file or directory",
        });
      }
    }
  };

  const name = parts.at(-1);
  if (!name) {
    throw new PullPathError({
      path: options.remotePath,
      reason: "path has no file name",
    });
  }

  let kind: PullManifest["kind"];
  if (targetStats.isFile()) {
    kind = "file";
    reserveEntry();
    await addFile(parts, name, options.remotePath);
  } else if (targetStats.isDirectory()) {
    kind = "directory";
    await walk(parts, "", options.remotePath);
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
    name,
    totalBytes,
  };

  return {
    manifest,
    read: (entry, signal) => {
      const file = files.get(entry.path);
      if (
        !file ||
        file.revision.digest !== entry.digest ||
        file.revision.size !== entry.size
      ) {
        return Stream.fail(changed(entry.path));
      }
      return streamPlannedFile(file, limits, signal);
    },
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

const destinationConflict = (cause: unknown, destination: string): PullError =>
  hasCode(cause, "EEXIST") || hasCode(cause, "ENOTEMPTY")
    ? new PullDestinationExistsError({ path: destination })
    : mapPullError(cause, "commit destination", destination);

const commitFile = (
  payload: string,
  destination: string
): Effect.Effect<void, PullError> =>
  Effect.tryPromise({
    catch: (cause) => destinationConflict(cause, destination),
    try: () => link(payload, destination),
  });

const commitDirectory = (
  payload: string,
  destination: string
): Effect.Effect<void, PullError> =>
  Effect.try({
    catch: (cause) => mapPullError(cause, "commit destination", destination),
    try: () => moveDirectoryNoReplace(payload, destination),
  }).pipe(
    Effect.flatMap((moved) => {
      if (moved) {
        return Effect.void;
      }
      return destinationExists(destination).pipe(
        Effect.flatMap((exists): Effect.Effect<void, PullError> => {
          const error: PullError = exists
            ? new PullDestinationExistsError({ path: destination })
            : new PullIOError({
                operation: "commit destination",
                path: destination,
              });
          return Effect.fail(error);
        })
      );
    })
  );

const commitDestination = (
  payload: string,
  destination: string,
  kind: PullManifest["kind"]
): Effect.Effect<void, PullError> =>
  kind === "file"
    ? commitFile(payload, destination)
    : commitDirectory(payload, destination);

const populateStage = (options: {
  readonly destination: string;
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
        yield* writeEntry(target, entry, options.read, options.signal);
        files += 1;
      }
    }

    yield* commitDestination(
      payload,
      options.destination,
      options.manifest.kind
    );
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
          (stage) =>
            fsEffect("remove pull staging directory", destination, () =>
              rm(stage, { force: true, recursive: true })
            )
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
    readonly servedRoot: string;
  }) =>
    Effect.tryPromise({
      catch: (cause) => mapPullError(cause, "prepare pull", options.remotePath),
      try: () => preparePullPromise(options),
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
