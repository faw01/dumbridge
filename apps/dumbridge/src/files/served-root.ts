import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  constants,
  promises as hostFileSystem,
  lstatSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { join, posix, win32 } from "node:path";
import { Effect, Schema } from "effect";
import { type IFileSystem, OverlayFs } from "just-bash";

const virtualRoot = "/workspace";
const maxConcurrentHostReads = 32;
const windowsDrivePattern = /^[a-z]:/i;
const readOnlyNoFollowNonBlocking =
  // biome-ignore lint/suspicious/noBitwiseOperators: POSIX open flags compose as a bitmask; nonblocking prevents special-file swaps from hanging before fstat.
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

const sourceRevisionBrand: unique symbol = Symbol("SourceRevision");

export interface SourceRevision {
  readonly [sourceRevisionBrand]: true;
}

export type SourceEntry =
  | {
      readonly kind: "directory";
      readonly path: string;
      readonly revision: SourceRevision;
    }
  | {
      readonly kind: "other";
      readonly path: string;
      readonly revision: SourceRevision;
    }
  | {
      readonly kind: "file";
      readonly path: string;
      readonly revision: SourceRevision;
      readonly size: number;
    };

export interface SourceDirectory {
  readonly children: readonly string[];
  readonly path: string;
  readonly revision: SourceRevision;
}

export interface SourceFileExpectation {
  readonly digest: string;
  readonly revision: SourceRevision;
  readonly size: number;
}

export interface SourceFileScan {
  readonly digest: string;
  readonly revision: SourceRevision;
  readonly size: number;
}

export interface ServedRootPullView {
  readonly inspect: (
    path: string,
    options: { readonly expected?: SourceRevision },
    signal: AbortSignal
  ) => Promise<SourceEntry>;
  readonly list: (
    path: string,
    options: {
      readonly expected?: SourceRevision;
      readonly reserve: () => void;
    },
    signal: AbortSignal
  ) => Promise<SourceDirectory>;
  readonly scan: (options: {
    readonly chunkBytes: number;
    readonly expected?: SourceFileExpectation;
    readonly maxFileBytes: number;
    readonly path: string;
    readonly signal: AbortSignal;
  }) => AsyncGenerator<Uint8Array, SourceFileScan>;
}

interface ServedRootIdentity {
  readonly birthtimeMs: number;
  readonly device: number;
  readonly inode: number;
}

type PathKind = "directory" | "file" | "other" | "symlink";

type PathComponentSnapshot =
  | { readonly state: "missing" }
  | {
      readonly identity: ServedRootIdentity;
      readonly kind: PathKind;
      readonly state: "present";
    };

type VirtualPathSnapshot = readonly PathComponentSnapshot[] | undefined;

export type ServedRootLimit = "file-read" | "overlay" | "overlay-entries";

interface ServedRootReadLimits {
  readonly maxFileReadBytes: number;
  readonly maxOverlayBytes: number;
  readonly maxOverlayEntries: number;
}

interface ServedRootReadView {
  readonly begin: (signal: AbortSignal) => void;
  readonly fileSystem: IFileSystem;
  readonly limitExceeded: ServedRootLimit | undefined;
  readonly sourceFailure:
    | ServedRootChangedError
    | ServedRootSourceChangedError
    | undefined;
  readonly workingDirectory: "/workspace";
}

class InvalidServedRootError extends Schema.TaggedErrorClass<InvalidServedRootError>()(
  "InvalidServedRootError",
  { message: Schema.String }
) {}

export class ServedRootChangedError extends Schema.TaggedErrorClass<ServedRootChangedError>()(
  "ServedRootChangedError",
  { message: Schema.String }
) {}

export class ServedRootPathError extends Schema.TaggedErrorClass<ServedRootPathError>()(
  "ServedRootPathError",
  {
    path: Schema.String,
    reason: Schema.String,
  }
) {}

export class ServedRootNotFoundError extends Schema.TaggedErrorClass<ServedRootNotFoundError>()(
  "ServedRootNotFoundError",
  { path: Schema.String }
) {}

export class ServedRootSymlinkError extends Schema.TaggedErrorClass<ServedRootSymlinkError>()(
  "ServedRootSymlinkError",
  { path: Schema.String }
) {}

export class ServedRootEntryTypeError extends Schema.TaggedErrorClass<ServedRootEntryTypeError>()(
  "ServedRootEntryTypeError",
  {
    actual: Schema.String,
    expected: Schema.String,
    path: Schema.String,
  }
) {}

export class ServedRootSourceChangedError extends Schema.TaggedErrorClass<ServedRootSourceChangedError>()(
  "ServedRootSourceChangedError",
  { path: Schema.String }
) {}

export class ServedRootFileLimitError extends Schema.TaggedErrorClass<ServedRootFileLimitError>()(
  "ServedRootFileLimitError",
  {
    maximum: Schema.Number,
    observed: Schema.Number,
    path: Schema.String,
  }
) {}

export class ServedRootIOError extends Schema.TaggedErrorClass<ServedRootIOError>()(
  "ServedRootIOError",
  {
    operation: Schema.String,
    path: Schema.String,
  }
) {}

export class ServedRootLimitSignal extends Error {
  readonly limit: ServedRootLimit;

  constructor(limit: ServedRootLimit) {
    super(`served root ${limit} limit exceeded`);
    this.limit = limit;
  }
}

const servedRootChanged = () =>
  new ServedRootChangedError({
    message: "served root changed after bridge start",
  });
const identityFrom = (stats: Stats): ServedRootIdentity => ({
  birthtimeMs: stats.birthtimeMs,
  device: stats.dev,
  inode: stats.ino,
});

const identitiesMatch = (
  expected: ServedRootIdentity,
  observed: ServedRootIdentity
) =>
  expected.birthtimeMs === observed.birthtimeMs &&
  expected.device === observed.device &&
  expected.inode === observed.inode;

const pathKindFrom = (stats: Stats): PathKind => {
  if (stats.isSymbolicLink()) {
    return "symlink";
  }
  if (stats.isDirectory()) {
    return "directory";
  }
  if (stats.isFile()) {
    return "file";
  }
  return "other";
};

interface SourceFingerprint {
  readonly ctimeMs: number;
  readonly device: number;
  readonly inode: number;
  readonly kind: Exclude<PathKind, "symlink">;
  readonly mtimeMs: number;
  readonly size: number;
}

const sourceRevisions = new WeakMap<SourceRevision, SourceFingerprint>();

const sourceKindFrom = (stats: Stats): Exclude<PathKind, "symlink"> => {
  if (stats.isDirectory()) {
    return "directory";
  }
  if (stats.isFile()) {
    return "file";
  }
  return "other";
};

const sourceFingerprintFrom = (stats: Stats): SourceFingerprint => ({
  ctimeMs: stats.ctimeMs,
  device: stats.dev,
  inode: stats.ino,
  kind: sourceKindFrom(stats),
  mtimeMs: stats.mtimeMs,
  size: stats.size,
});

const sourceRevisionFrom = (stats: Stats): SourceRevision => {
  const revision = Object.freeze({
    [sourceRevisionBrand]: true as const,
  });
  sourceRevisions.set(revision, sourceFingerprintFrom(stats));
  return revision;
};

const sourceRevisionMatches = (revision: SourceRevision, stats: Stats) => {
  const expected = sourceRevisions.get(revision);
  if (expected === undefined) {
    return false;
  }
  const observed = sourceFingerprintFrom(stats);
  return (
    expected.ctimeMs === observed.ctimeMs &&
    expected.device === observed.device &&
    expected.inode === observed.inode &&
    expected.kind === observed.kind &&
    expected.mtimeMs === observed.mtimeMs &&
    expected.size === observed.size
  );
};

const sourceEntryFrom = (path: string, stats: Stats): SourceEntry => {
  const revision = sourceRevisionFrom(stats);
  if (stats.isFile()) {
    return Object.freeze({
      kind: "file",
      path,
      revision,
      size: stats.size,
    });
  }
  return Object.freeze({
    kind: sourceKindFrom(stats) === "directory" ? "directory" : "other",
    path,
    revision,
  });
};

const pathComponentsMatch = (
  expected: PathComponentSnapshot,
  observed: PathComponentSnapshot
) => {
  if (expected.state === "missing" || observed.state === "missing") {
    return expected.state === observed.state;
  }
  return (
    expected.kind === observed.kind &&
    identitiesMatch(expected.identity, observed.identity)
  );
};

const pathSnapshotsMatch = (
  expected: VirtualPathSnapshot,
  observed: VirtualPathSnapshot
) => {
  if (expected === undefined || observed === undefined) {
    return expected === observed;
  }
  return (
    expected.length === observed.length &&
    expected.every((component, index) =>
      pathComponentsMatch(component, observed[index] as PathComponentSnapshot)
    )
  );
};

const inspectDirectory = (path: string) => {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error("served root is not a directory");
  }
  return stats;
};

const isMissingPath = (cause: unknown) => {
  if (!(cause instanceof Error)) {
    return false;
  }
  const { code } = cause as NodeJS.ErrnoException;
  return code === "ENOENT" || code === "ENOTDIR";
};

const hostSegmentsFrom = (virtualPath: string) => {
  if (virtualPath.includes("\0") || virtualPath.includes("\\")) {
    throw new Error("EINVAL: invalid virtual path");
  }
  const normalized = posix.resolve("/", virtualPath);
  if (normalized === virtualRoot) {
    return [];
  }
  if (!normalized.startsWith(`${virtualRoot}/`)) {
    return;
  }
  return normalized.slice(virtualRoot.length + 1).split("/");
};

export class ServedRoot {
  readonly #hostPath: string;
  readonly #identity: ServedRootIdentity;

  private constructor(hostPath: string, identity: ServedRootIdentity) {
    this.#hostPath = hostPath;
    this.#identity = identity;
  }

  #assertCurrent() {
    try {
      const stats = inspectDirectory(this.#hostPath);
      const currentPath = realpathSync(this.#hostPath);
      if (
        currentPath !== this.#hostPath ||
        !identitiesMatch(this.#identity, identityFrom(stats))
      ) {
        throw new Error("served root identity changed");
      }
    } catch {
      // biome-ignore lint/style/useErrorCause: The cause may expose a host path.
      throw servedRootChanged();
    }
  }

  #snapshotVirtualPath(virtualPath: string): VirtualPathSnapshot {
    const segments = hostSegmentsFrom(virtualPath);
    if (segments === undefined) {
      return;
    }
    const snapshot: PathComponentSnapshot[] = [];
    let hostPath = this.#hostPath;
    for (const segment of segments) {
      hostPath = join(hostPath, segment);
      try {
        const stats = lstatSync(hostPath);
        snapshot.push({
          identity: identityFrom(stats),
          kind: pathKindFrom(stats),
          state: "present",
        });
        if (stats.isSymbolicLink()) {
          break;
        }
      } catch (cause) {
        if (isMissingPath(cause)) {
          snapshot.push({ state: "missing" });
          break;
        }
        throw servedRootChanged();
      }
    }
    return snapshot;
  }

  #snapshotVirtualPaths(paths: readonly string[]) {
    return [...new Set(paths)].map((path) => this.#snapshotVirtualPath(path));
  }

  #assertBoundaryUnchanged(
    paths: readonly string[],
    expected: readonly VirtualPathSnapshot[]
  ) {
    this.#assertCurrent();
    for (const [index, virtualPath] of paths.entries()) {
      if (
        !pathSnapshotsMatch(
          expected[index],
          this.#snapshotVirtualPath(virtualPath)
        )
      ) {
        throw servedRootChanged();
      }
    }
  }

  async #guardPaths<A>(
    paths: readonly string[],
    operation: () => Promise<A>
  ): Promise<A> {
    this.#assertCurrent();
    const guardedPaths = [...new Set(paths)];
    const expected = this.#snapshotVirtualPaths(guardedPaths);
    try {
      const result = await operation();
      this.#assertBoundaryUnchanged(guardedPaths, expected);
      return result;
    } catch (cause) {
      this.#assertBoundaryUnchanged(guardedPaths, expected);
      throw cause;
    }
  }

  async #guardPathResource<A>(
    paths: readonly string[],
    acquire: () => Promise<A>,
    release: (resource: A) => Promise<void>
  ): Promise<A> {
    this.#assertCurrent();
    const guardedPaths = [...new Set(paths)];
    const expected = this.#snapshotVirtualPaths(guardedPaths);
    let acquired = false;
    let resource: A | undefined;
    try {
      resource = await acquire();
      acquired = true;
      this.#assertBoundaryUnchanged(guardedPaths, expected);
      return resource;
    } catch (cause) {
      let releaseCause: unknown;
      if (acquired) {
        try {
          await release(resource as A);
        } catch (error) {
          releaseCause = error;
        }
      }
      this.#assertBoundaryUnchanged(guardedPaths, expected);
      if (releaseCause !== undefined) {
        throw releaseCause;
      }
      throw cause;
    }
  }

  #guardPathsSync<A>(paths: readonly string[], operation: () => A): A {
    this.#assertCurrent();
    const guardedPaths = [...new Set(paths)];
    const expected = this.#snapshotVirtualPaths(guardedPaths);
    try {
      const result = operation();
      this.#assertBoundaryUnchanged(guardedPaths, expected);
      return result;
    } catch (cause) {
      this.#assertBoundaryUnchanged(guardedPaths, expected);
      throw cause;
    }
  }

  #assertObservedPaths(paths: readonly string[]) {
    for (const virtualPath of paths) {
      const segments = hostSegmentsFrom(virtualPath);
      if (segments === undefined) {
        continue;
      }
      let hostPath = this.#hostPath;
      for (const [index, segment] of segments.entries()) {
        hostPath = join(hostPath, segment);
        try {
          const stats = lstatSync(hostPath);
          if (stats.isSymbolicLink() && index < segments.length - 1) {
            throw servedRootChanged();
          }
        } catch (cause) {
          if (cause instanceof ServedRootChangedError) {
            throw cause;
          }
          if (isMissingPath(cause)) {
            break;
          }
          throw servedRootChanged();
        }
      }
    }
  }
  static readonly make = Effect.fn("ServedRoot.make")((path: string) =>
    Effect.try({
      catch: () =>
        new InvalidServedRootError({
          message: "served root must be an existing directory",
        }),
      try: () => {
        const canonicalPath = realpathSync(path);
        const stats = inspectDirectory(canonicalPath);
        return new ServedRoot(canonicalPath, identityFrom(stats));
      },
    })
  );

  readonly verify = Effect.fn("ServedRoot.verify")(() =>
    Effect.try({
      catch: servedRootChanged,
      try: () => this.#assertCurrent(),
    })
  );

  readonly openPullView = () =>
    this.#guardPathsSync([], () => {
      const view = new PullView(
        this.#hostPath,
        (paths, operation) => this.#guardPaths(paths, operation),
        (paths, acquire, release) =>
          this.#guardPathResource(paths, acquire, release)
      );
      return Object.freeze({
        inspect: (
          path: string,
          options: { readonly expected?: SourceRevision },
          signal: AbortSignal
        ) => view.inspect(path, options, signal),
        list: (
          path: string,
          options: {
            readonly expected?: SourceRevision;
            readonly reserve: () => void;
          },
          signal: AbortSignal
        ) => view.list(path, options, signal),
        scan: (options: {
          readonly chunkBytes: number;
          readonly expected?: SourceFileExpectation;
          readonly maxFileBytes: number;
          readonly path: string;
          readonly signal: AbortSignal;
        }) => view.scan(options),
      } satisfies ServedRootPullView);
    });

  readonly openReadView = (limits: ServedRootReadLimits) =>
    this.#guardPathsSync([], () => {
      const fileSystem = new RequestBudgetOverlayFs(
        this.#hostPath,
        limits,
        (paths, operation) => this.#guardPaths(paths, operation),
        (paths, operation) => this.#guardPathsSync(paths, operation),
        (paths) => this.#assertObservedPaths(paths)
      );
      return Object.freeze({
        begin: (signal: AbortSignal) => fileSystem.begin(signal),
        fileSystem: fileSystemFacade(fileSystem),
        get limitExceeded() {
          return fileSystem.limitExceeded;
        },
        get sourceFailure() {
          return fileSystem.sourceFailure;
        },
        workingDirectory: virtualRoot,
      } satisfies ServedRootReadView);
    });
}

type AsyncPathGuard = <A>(
  paths: readonly string[],
  operation: () => Promise<A>
) => Promise<A>;

type AsyncPathResourceGuard = <A>(
  paths: readonly string[],
  acquire: () => Promise<A>,
  release: (resource: A) => Promise<void>
) => Promise<A>;

type SyncPathGuard = <A>(paths: readonly string[], operation: () => A) => A;

interface ParsedSourcePath {
  readonly parts: readonly string[];
  readonly path: string;
  readonly virtualPath: string;
}

interface InspectedSourcePath {
  readonly entry: SourceEntry;
  readonly hostPath: string;
}

class SourceReservationFailure {
  readonly cause: unknown;

  constructor(cause: unknown) {
    this.cause = cause;
  }
}

const parsedSourcePath = (path: string): ParsedSourcePath => {
  const parts = path.split("/");
  if (
    path.length === 0 ||
    path.includes("\0") ||
    path.includes("\\") ||
    posix.isAbsolute(path) ||
    win32.isAbsolute(path) ||
    windowsDrivePattern.test(path) ||
    posix.normalize(path) !== path ||
    parts.some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw new ServedRootPathError({
      path,
      reason: "path must be canonical and relative",
    });
  }
  return {
    parts,
    path,
    virtualPath: `${virtualRoot}/${path}`,
  };
};

const sourceChanged = (path: string) =>
  new ServedRootSourceChangedError({ path });

const requireSourceKind = <Kind extends "directory" | "file">(
  entry: SourceEntry,
  expected: Kind
): Extract<SourceEntry, { readonly kind: Kind }> => {
  if (entry.kind !== expected) {
    throw new ServedRootEntryTypeError({
      actual: entry.kind,
      expected,
      path: entry.path,
    });
  }
  return entry as Extract<SourceEntry, { readonly kind: Kind }>;
};

const inspectSourcePath = async (options: {
  readonly expected: SourceRevision | undefined;
  readonly hostRoot: string;
  readonly parsed: ParsedSourcePath;
  readonly signal: AbortSignal;
}): Promise<InspectedSourcePath> => {
  let hostPath = options.hostRoot;
  let stats: Stats | undefined;
  for (const [index, part] of options.parsed.parts.entries()) {
    options.signal.throwIfAborted();
    hostPath = join(hostPath, part);
    try {
      // biome-ignore lint/performance/noAwaitInLoops: Source components must be checked in order.
      stats = await hostFileSystem.lstat(hostPath);
    } catch (cause) {
      options.signal.throwIfAborted();
      if (isMissingPath(cause)) {
        if (options.expected !== undefined) {
          throw sourceChanged(options.parsed.path);
        }
        // biome-ignore lint/style/useErrorCause: The Node cause may expose the host path.
        throw new ServedRootNotFoundError({
          path: options.parsed.parts.slice(0, index + 1).join("/"),
        });
      }
      throw cause;
    }
    options.signal.throwIfAborted();
    if (stats.isSymbolicLink()) {
      throw new ServedRootSymlinkError({
        path: options.parsed.parts.slice(0, index + 1).join("/"),
      });
    }
  }
  if (stats === undefined) {
    throw new ServedRootPathError({
      path: options.parsed.path,
      reason: "path must have at least one component",
    });
  }
  if (
    options.expected !== undefined &&
    !sourceRevisionMatches(options.expected, stats)
  ) {
    throw sourceChanged(options.parsed.path);
  }
  return {
    entry: sourceEntryFrom(options.parsed.path, stats),
    hostPath,
  };
};

const isServedRootPullError = (cause: unknown) =>
  cause instanceof ServedRootPathError ||
  cause instanceof ServedRootNotFoundError ||
  cause instanceof ServedRootSymlinkError ||
  cause instanceof ServedRootEntryTypeError ||
  cause instanceof ServedRootSourceChangedError ||
  cause instanceof ServedRootFileLimitError ||
  cause instanceof ServedRootIOError ||
  cause instanceof ServedRootChangedError;

const mapServedRootPullError = (options: {
  readonly cause: unknown;
  readonly expected: boolean;
  readonly operation: string;
  readonly path: string;
  readonly signal: AbortSignal;
}): unknown => {
  if (
    options.cause instanceof SourceReservationFailure ||
    isServedRootPullError(options.cause)
  ) {
    return options.cause;
  }
  if (options.signal.aborted) {
    return options.signal.reason ?? options.cause;
  }
  if (isMissingPath(options.cause)) {
    return options.expected
      ? sourceChanged(options.path)
      : new ServedRootNotFoundError({ path: options.path });
  }
  return new ServedRootIOError({
    operation: options.operation,
    path: options.path,
  });
};

const enforceSourceFileLimit = (
  path: string,
  observed: number,
  maximum: number
) => {
  if (!Number.isSafeInteger(observed) || observed < 0 || observed > maximum) {
    throw new ServedRootFileLimitError({ maximum, observed, path });
  }
};

const compareSourceNames = (left: string, right: string) => {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
};

class PullView {
  readonly #guardPaths: AsyncPathGuard;
  readonly #guardResource: AsyncPathResourceGuard;
  readonly #hostRoot: string;

  constructor(
    hostRoot: string,
    guardPaths: AsyncPathGuard,
    guardResource: AsyncPathResourceGuard
  ) {
    this.#hostRoot = hostRoot;
    this.#guardPaths = guardPaths;
    this.#guardResource = guardResource;
  }

  async inspect(
    path: string,
    options: { readonly expected?: SourceRevision },
    signal: AbortSignal
  ): Promise<SourceEntry> {
    try {
      signal.throwIfAborted();
      const parsed = parsedSourcePath(path);
      const inspected = await this.#guardPaths([parsed.virtualPath], () =>
        inspectSourcePath({
          expected: options.expected,
          hostRoot: this.#hostRoot,
          parsed,
          signal,
        })
      );
      signal.throwIfAborted();
      return inspected.entry;
    } catch (cause) {
      throw mapServedRootPullError({
        cause,
        expected: options.expected !== undefined,
        operation: "inspect source",
        path,
        signal,
      });
    }
  }

  async list(
    path: string,
    options: {
      readonly expected?: SourceRevision;
      readonly reserve: () => void;
    },
    signal: AbortSignal
  ): Promise<SourceDirectory> {
    try {
      signal.throwIfAborted();
      const parsed = parsedSourcePath(path);
      const result = await this.#guardPaths([parsed.virtualPath], async () => {
        const inspected = await inspectSourcePath({
          expected: options.expected,
          hostRoot: this.#hostRoot,
          parsed,
          signal,
        });
        const directoryEntry = requireSourceKind(inspected.entry, "directory");
        signal.throwIfAborted();
        const directory = await hostFileSystem.opendir(inspected.hostPath, {
          bufferSize: 1,
        });
        const children: string[] = [];
        try {
          let child = await directory.read();
          while (child !== null) {
            signal.throwIfAborted();
            try {
              options.reserve();
            } catch (cause) {
              // biome-ignore lint/style/useErrorCause: The wrapper preserves and later rethrows the exact caller error.
              throw new SourceReservationFailure(cause);
            }
            children.push(child.name);
            // biome-ignore lint/performance/noAwaitInLoops: Directory reads stop when the caller's reservation limit is reached.
            child = await directory.read();
          }
          signal.throwIfAborted();
        } catch (cause) {
          try {
            await directory.close();
          } catch {
            // Preserve the primary read, limit, or cancellation failure.
          }
          throw cause;
        }
        await directory.close();
        await inspectSourcePath({
          expected: directoryEntry.revision,
          hostRoot: this.#hostRoot,
          parsed,
          signal,
        });
        children.sort(compareSourceNames);
        return Object.freeze({
          children: Object.freeze(children),
          path,
          revision: directoryEntry.revision,
        });
      });
      signal.throwIfAborted();
      return result;
    } catch (cause) {
      const mapped = mapServedRootPullError({
        cause,
        expected: options.expected !== undefined,
        operation: "list source directory",
        path,
        signal,
      });
      if (mapped instanceof SourceReservationFailure) {
        throw mapped.cause;
      }
      throw mapped;
    }
  }

  async *scan(options: {
    readonly chunkBytes: number;
    readonly expected?: SourceFileExpectation;
    readonly maxFileBytes: number;
    readonly path: string;
    readonly signal: AbortSignal;
  }): AsyncGenerator<Uint8Array, SourceFileScan> {
    try {
      options.signal.throwIfAborted();
      const parsed = parsedSourcePath(options.path);
      const opened = await this.#guardResource(
        [parsed.virtualPath],
        async () => {
          const inspected = await inspectSourcePath({
            expected: options.expected?.revision,
            hostRoot: this.#hostRoot,
            parsed,
            signal: options.signal,
          });
          const entry = requireSourceKind(inspected.entry, "file");
          enforceSourceFileLimit(
            options.path,
            entry.size,
            options.maxFileBytes
          );
          if (
            options.expected !== undefined &&
            entry.size !== options.expected.size
          ) {
            throw sourceChanged(options.path);
          }
          options.signal.throwIfAborted();
          const handle = await hostFileSystem.open(
            inspected.hostPath,
            readOnlyNoFollowNonBlocking
          );
          return { entry, handle };
        },
        ({ handle }) => handle.close()
      );

      let closeFailure: unknown;
      let scanResult: SourceFileScan;
      try {
        options.signal.throwIfAborted();
        const hash = createHash("sha256");
        const buffer = Buffer.allocUnsafe(options.chunkBytes);
        let bytesRead = buffer.byteLength;
        let offset = 0;
        while (bytesRead > 0) {
          options.signal.throwIfAborted();
          // biome-ignore lint/performance/noAwaitInLoops: File offsets are read sequentially and each result is checked before it is yielded.
          const read = await this.#guardPaths(
            [parsed.virtualPath],
            async () => {
              await inspectSourcePath({
                expected: opened.entry.revision,
                hostRoot: this.#hostRoot,
                parsed,
                signal: options.signal,
              });
              const before = await opened.handle.stat();
              if (!sourceRevisionMatches(opened.entry.revision, before)) {
                throw sourceChanged(options.path);
              }
              const result = await opened.handle.read(
                buffer,
                0,
                buffer.byteLength,
                offset
              );
              const after = await opened.handle.stat();
              if (!sourceRevisionMatches(opened.entry.revision, after)) {
                throw sourceChanged(options.path);
              }
              await inspectSourcePath({
                expected: opened.entry.revision,
                hostRoot: this.#hostRoot,
                parsed,
                signal: options.signal,
              });
              options.signal.throwIfAborted();
              return result;
            }
          );
          ({ bytesRead } = read);
          if (bytesRead > 0) {
            const nextOffset = offset + bytesRead;
            enforceSourceFileLimit(
              options.path,
              nextOffset,
              options.maxFileBytes
            );
            if (
              options.expected !== undefined &&
              nextOffset > options.expected.size
            ) {
              throw sourceChanged(options.path);
            }
            const chunk = Uint8Array.from(buffer.subarray(0, bytesRead));
            hash.update(chunk);
            offset = nextOffset;
            options.signal.throwIfAborted();
            yield chunk;
          }
        }

        const digest = hash.digest("hex");
        if (
          offset !== opened.entry.size ||
          (options.expected !== undefined &&
            (offset !== options.expected.size ||
              digest !== options.expected.digest))
        ) {
          throw sourceChanged(options.path);
        }
        options.signal.throwIfAborted();
        scanResult = Object.freeze({
          digest,
          revision: opened.entry.revision,
          size: opened.entry.size,
        });
      } finally {
        try {
          await opened.handle.close();
        } catch (cause) {
          closeFailure = cause;
        }
      }
      if (closeFailure !== undefined) {
        throw closeFailure;
      }
      return scanResult;
    } catch (cause) {
      throw mapServedRootPullError({
        cause,
        expected: options.expected !== undefined,
        operation: "scan source file",
        path: options.path,
        signal: options.signal,
      });
    }
  }
}

class RequestBudgetOverlayFs extends OverlayFs {
  limitExceeded: ServedRootLimit | undefined;
  sourceFailure:
    | ServedRootChangedError
    | ServedRootSourceChangedError
    | undefined;

  private activeHostReads = 0;
  private readonly chargedEntryPaths = new Set([virtualRoot]);
  private readonly hostRoot: string;
  private readonly maximumOverlayEntries: number;
  private readonly overlayFilePaths = new Set<string>();
  private readonly tombstonePaths = new Set<string>();
  private overlayEntries = 0;
  private overlayBytes = 0;
  private readBytes = 0;
  private readonly assertObservedPaths: (paths: readonly string[]) => void;
  private readonly guardPaths: AsyncPathGuard;
  private readonly guardPathsSync: SyncPathGuard;
  private readonly maximumOverlayBytes: number;
  private readonly maximumReadBytes: number;
  private signal: AbortSignal | undefined;

  constructor(
    hostRoot: string,
    limits: ServedRootReadLimits,
    guardPaths: AsyncPathGuard,
    guardPathsSync: SyncPathGuard,
    assertObservedPaths: (paths: readonly string[]) => void
  ) {
    super({
      allowSymlinks: false,
      maxFileReadSize: limits.maxFileReadBytes,
      mountPoint: virtualRoot,
      root: hostRoot,
    });
    this.hostRoot = hostRoot;
    this.maximumReadBytes = limits.maxFileReadBytes;
    this.maximumOverlayBytes = limits.maxOverlayBytes;
    this.maximumOverlayEntries = limits.maxOverlayEntries;
    this.guardPaths = guardPaths;
    this.guardPathsSync = guardPathsSync;
    this.assertObservedPaths = assertObservedPaths;
  }

  begin(signal: AbortSignal) {
    this.signal = signal;
  }

  private assertRequestOpen() {
    this.signal?.throwIfAborted();
    if (this.sourceFailure !== undefined) {
      throw this.sourceFailure;
    }
    if (this.limitExceeded !== undefined) {
      throw new ServedRootLimitSignal(this.limitExceeded);
    }
  }

  private async whileRequestOpen<A>(operation: () => Promise<A>): Promise<A> {
    this.assertRequestOpen();
    const result = await operation();
    this.assertRequestOpen();
    return result;
  }

  private async whileGuarded<A>(
    paths: readonly string[],
    operation: () => Promise<A>
  ): Promise<A> {
    this.assertRequestOpen();
    try {
      return await this.guardPaths(paths, () =>
        this.whileRequestOpen(operation)
      );
    } catch (cause) {
      if (
        cause instanceof ServedRootChangedError ||
        cause instanceof ServedRootSourceChangedError
      ) {
        this.sourceFailure = cause;
      }
      throw cause;
    }
  }

  private whileGuardedSync<A>(paths: readonly string[], operation: () => A): A {
    this.assertRequestOpen();
    try {
      return this.guardPathsSync(paths, () => {
        this.assertRequestOpen();
        const result = operation();
        this.assertRequestOpen();
        return result;
      });
    } catch (cause) {
      if (
        cause instanceof ServedRootChangedError ||
        cause instanceof ServedRootSourceChangedError
      ) {
        this.sourceFailure = cause;
      }
      throw cause;
    }
  }

  private reserve(kind: ServedRootLimit, bytes: number) {
    this.assertRequestOpen();
    let consumed = this.overlayEntries;
    let maximum = this.maximumOverlayEntries;
    if (kind === "file-read") {
      consumed = this.readBytes;
      maximum = this.maximumReadBytes;
    } else if (kind === "overlay") {
      consumed = this.overlayBytes;
      maximum = this.maximumOverlayBytes;
    }
    if (bytes > maximum - consumed) {
      this.limitExceeded ??= kind;
      throw new ServedRootLimitSignal(this.limitExceeded);
    }
    if (kind === "file-read") {
      this.readBytes += bytes;
    } else if (kind === "overlay") {
      this.overlayBytes += bytes;
    } else {
      this.overlayEntries += bytes;
    }
  }

  private releaseRead(bytes: number) {
    this.readBytes -= bytes;
  }

  private acquireHostRead() {
    this.assertRequestOpen();
    if (this.activeHostReads >= maxConcurrentHostReads) {
      this.limitExceeded ??= "file-read";
      throw new ServedRootLimitSignal(this.limitExceeded);
    }
    this.activeHostReads += 1;
  }

  private normalize(path: string) {
    return super.resolvePath("/", path);
  }

  private chargeEntries(path: string, includeParents: boolean) {
    const normalized = this.normalize(path);
    const paths = [normalized];
    if (includeParents) {
      let parent = normalized;
      while (parent !== "/") {
        const separator = parent.lastIndexOf("/");
        parent = separator <= 0 ? "/" : parent.slice(0, separator);
        if (parent !== "/") {
          paths.push(parent);
        }
      }
    }
    const fresh = paths.filter((item) => !this.chargedEntryPaths.has(item));
    this.reserve("overlay-entries", fresh.length);
    for (const item of fresh) {
      this.chargedEntryPaths.add(item);
    }
  }

  private hostLocation(path: string) {
    const normalized = this.normalize(path);
    if (
      normalized !== virtualRoot &&
      !normalized.startsWith(`${virtualRoot}/`)
    ) {
      return;
    }
    const suffix = normalized.slice(virtualRoot.length);
    const relative = suffix.startsWith("/") ? suffix.slice(1) : suffix;
    const segments = relative === "" ? [] : relative.split("/");
    if (
      segments.some(
        (segment) => segment.includes("\\") || segment.includes("\0")
      )
    ) {
      return;
    }
    return { normalized, path: join(this.hostRoot, ...segments), segments };
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: security checks stay adjacent to the bounded read they protect
  private async readHostFile(
    location: NonNullable<ReturnType<RequestBudgetOverlayFs["hostLocation"]>>
  ): Promise<Uint8Array> {
    let handle: Awaited<ReturnType<typeof hostFileSystem.open>> | undefined;
    let hasHostReadSlot = false;
    let leafIdentity:
      | {
          readonly device: number;
          readonly inode: number;
          readonly size: number;
        }
      | undefined;
    let reserved = 0;
    try {
      if (location.segments.length === 0) {
        throw Object.assign(new Error("served root is a directory"), {
          code: "EISDIR",
        });
      }
      let current = this.hostRoot;
      for (const [index, segment] of location.segments.entries()) {
        current = join(current, segment);
        // biome-ignore lint/performance/noAwaitInLoops: components must be validated in order and cancellation is checked per component
        const stats = await this.whileRequestOpen(() =>
          hostFileSystem.lstat(current)
        );
        if (stats.isSymbolicLink()) {
          throw Object.assign(new Error("symbolic links are disabled"), {
            code: "ENOENT",
          });
        }
        if (index < location.segments.length - 1 && !stats.isDirectory()) {
          throw Object.assign(new Error("path component is not a directory"), {
            code: "ENOTDIR",
          });
        }
        if (index === location.segments.length - 1 && !stats.isFile()) {
          throw Object.assign(new Error("unsupported file type"), {
            code: stats.isDirectory() ? "EISDIR" : "EFTYPE",
          });
        }
        if (index === location.segments.length - 1) {
          leafIdentity = {
            device: stats.dev,
            inode: stats.ino,
            size: stats.size,
          };
        }
      }

      if (leafIdentity === undefined) {
        throw Object.assign(new Error("file disappeared"), { code: "ENOENT" });
      }
      this.reserve("file-read", leafIdentity.size);
      reserved = leafIdentity.size;
      this.acquireHostRead();
      hasHostReadSlot = true;
      handle = await this.whileRequestOpen(() =>
        hostFileSystem.open(location.path, readOnlyNoFollowNonBlocking)
      );
      const openedHandle = handle;
      const stats = await this.whileRequestOpen(() => openedHandle.stat());
      if (!stats.isFile()) {
        throw Object.assign(new Error("unsupported file type"), {
          code: "EFTYPE",
        });
      }
      if (
        stats.dev !== leafIdentity.device ||
        stats.ino !== leafIdentity.inode
      ) {
        throw Object.assign(new Error("file identity changed"), {
          code: "ESTALE",
        });
      }
      if (stats.size > reserved) {
        this.reserve("file-read", stats.size - reserved);
      } else if (stats.size < reserved) {
        this.releaseRead(reserved - stats.size);
      }
      reserved = stats.size;
      const content = Buffer.allocUnsafe(stats.size);
      let offset = 0;
      while (offset < content.byteLength) {
        const length = Math.min(64 * 1024, content.byteLength - offset);
        // biome-ignore lint/performance/noAwaitInLoops: bounded chunks provide cooperative cancellation
        const result = await this.whileRequestOpen(() =>
          openedHandle.read(content, offset, length, offset)
        );
        if (result.bytesRead === 0) {
          break;
        }
        offset += result.bytesRead;
      }

      if (offset === content.byteLength) {
        const probe = Buffer.allocUnsafe(1);
        const result = await this.whileRequestOpen(() =>
          openedHandle.read(probe, 0, 1, offset)
        );
        if (result.bytesRead > 0) {
          this.limitExceeded ??= "file-read";
          throw new ServedRootLimitSignal(this.limitExceeded);
        }
      }

      if (offset < reserved) {
        throw new ServedRootSourceChangedError({
          path: location.normalized,
        });
      }
      return content;
    } catch (error) {
      if (error instanceof ServedRootLimitSignal) {
        throw error;
      }
      this.signal?.throwIfAborted();
      if (reserved > 0) {
        this.releaseRead(reserved);
      }
      if (error instanceof ServedRootSourceChangedError) {
        throw error;
      }
      const { code } = error as NodeJS.ErrnoException;
      const safeCode =
        code &&
        [
          "EACCES",
          "EFTYPE",
          "EISDIR",
          "ELOOP",
          "ENOENT",
          "ENOTDIR",
          "EPERM",
          "ESTALE",
        ].includes(code)
          ? code
          : "EIO";
      throw Object.assign(
        new Error(`${safeCode}: unable to read '${location.normalized}'`),
        { code: safeCode }
      );
    } finally {
      await handle?.close().catch(() => undefined);
      if (hasHostReadSlot) {
        this.activeHostReads -= 1;
      }
    }
  }

  private async readOverlayFile(
    ...args: Parameters<OverlayFs["readFileBuffer"]>
  ): ReturnType<OverlayFs["readFileBuffer"]> {
    let reservedBytes = 0;
    try {
      const stats = await super.lstat(args[0]);
      if (!stats.isFile) {
        throw Object.assign(new Error("unsupported file type"), {
          code: stats.isDirectory ? "EISDIR" : "EFTYPE",
        });
      }
      reservedBytes = stats.size;
      this.reserve("file-read", reservedBytes);
      const content = await super.readFileBuffer(...args);
      if (content.byteLength > reservedBytes) {
        this.reserve("file-read", content.byteLength - reservedBytes);
      } else if (content.byteLength < reservedBytes) {
        this.releaseRead(reservedBytes - content.byteLength);
      }
      return content;
    } catch (error) {
      if (!(error instanceof ServedRootLimitSignal) && reservedBytes > 0) {
        this.releaseRead(reservedBytes);
      }
      throw error;
    }
  }

  override async readFileBuffer(
    ...args: Parameters<OverlayFs["readFileBuffer"]>
  ): ReturnType<OverlayFs["readFileBuffer"]> {
    try {
      return await this.whileGuarded([args[0]], () => {
        const normalized = this.normalize(args[0]);
        const location = this.hostLocation(normalized);
        const isServedPath =
          normalized === virtualRoot ||
          normalized.startsWith(`${virtualRoot}/`);
        if (isServedPath && location === undefined) {
          throw Object.assign(
            new Error(`ENOENT: unable to read '${normalized}'`),
            { code: "ENOENT" }
          );
        }
        if (
          location !== undefined &&
          !this.overlayFilePaths.has(normalized) &&
          !this.tombstonePaths.has(normalized)
        ) {
          return this.readHostFile(location);
        }
        return this.readOverlayFile(...args);
      });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("EFBIG:")) {
        this.limitExceeded = "file-read";
      }
      throw error;
    }
  }

  override async writeFile(
    ...args: Parameters<OverlayFs["writeFile"]>
  ): ReturnType<OverlayFs["writeFile"]> {
    await this.whileGuarded([args[0]], async () => {
      this.chargeEntries(args[0], true);
      this.reserve("overlay", fileContentSize(args[1], args[2]));
      await super.writeFile(...args);
      const normalized = this.normalize(args[0]);
      this.overlayFilePaths.add(normalized);
      this.tombstonePaths.delete(normalized);
    });
  }

  override async appendFile(
    ...args: Parameters<OverlayFs["appendFile"]>
  ): ReturnType<OverlayFs["appendFile"]> {
    await this.whileGuarded([args[0]], async () => {
      this.chargeEntries(args[0], true);
      const appendedBytes = fileContentSize(args[1], args[2]);
      const normalized = this.normalize(args[0]);
      let materializedBytes = 0;
      if (
        !(
          this.overlayFilePaths.has(normalized) ||
          this.tombstonePaths.has(normalized)
        )
      ) {
        try {
          const stats = await super.stat(args[0]);
          materializedBytes = stats.isFile ? stats.size : 0;
        } catch {
          materializedBytes = 0;
        }
      }
      this.reserve("overlay", materializedBytes + appendedBytes);
      await super.appendFile(...args);
      this.overlayFilePaths.add(normalized);
      this.tombstonePaths.delete(normalized);
    });
  }

  override exists(
    ...args: Parameters<OverlayFs["exists"]>
  ): ReturnType<OverlayFs["exists"]> {
    return this.whileGuarded([args[0]], () => super.exists(...args));
  }

  override stat(
    ...args: Parameters<OverlayFs["stat"]>
  ): ReturnType<OverlayFs["stat"]> {
    return this.whileGuarded([args[0]], () => super.stat(...args));
  }

  override lstat(
    ...args: Parameters<OverlayFs["lstat"]>
  ): ReturnType<OverlayFs["lstat"]> {
    return this.whileGuarded([args[0]], () => super.lstat(...args));
  }

  override async mkdir(
    ...args: Parameters<OverlayFs["mkdir"]>
  ): ReturnType<OverlayFs["mkdir"]> {
    await this.whileGuarded([args[0]], async () => {
      this.chargeEntries(args[0], true);
      await super.mkdir(...args);
      this.tombstonePaths.delete(this.normalize(args[0]));
    });
  }

  override readdir(
    ...args: Parameters<OverlayFs["readdir"]>
  ): ReturnType<OverlayFs["readdir"]> {
    return this.whileGuarded([args[0]], () => super.readdir(...args));
  }

  override readdirWithFileTypes(
    ...args: Parameters<OverlayFs["readdirWithFileTypes"]>
  ): ReturnType<OverlayFs["readdirWithFileTypes"]> {
    return this.whileGuarded([args[0]], () =>
      super.readdirWithFileTypes(...args)
    );
  }

  override async rm(
    ...args: Parameters<OverlayFs["rm"]>
  ): ReturnType<OverlayFs["rm"]> {
    await this.whileGuarded([args[0]], async () => {
      this.chargeEntries(args[0], false);
      await super.rm(...args);
      const normalized = this.normalize(args[0]);
      this.overlayFilePaths.delete(normalized);
      this.tombstonePaths.add(normalized);
    });
  }

  override cp(
    ...args: Parameters<OverlayFs["cp"]>
  ): ReturnType<OverlayFs["cp"]> {
    return this.whileGuarded([args[0], args[1]], () => super.cp(...args));
  }

  override mv(
    ...args: Parameters<OverlayFs["mv"]>
  ): ReturnType<OverlayFs["mv"]> {
    return this.whileGuarded([args[0], args[1]], () => super.mv(...args));
  }

  override async chmod(
    ...args: Parameters<OverlayFs["chmod"]>
  ): ReturnType<OverlayFs["chmod"]> {
    await this.whileGuarded([args[0]], async () => {
      const stats = await super.stat(args[0]);
      const normalized = this.normalize(args[0]);
      this.chargeEntries(normalized, false);
      if (stats.isFile && !this.overlayFilePaths.has(normalized)) {
        this.reserve("overlay", stats.size);
      }
      await super.chmod(...args);
      if (stats.isFile) {
        this.overlayFilePaths.add(normalized);
      }
    });
  }

  override async symlink(
    ...args: Parameters<OverlayFs["symlink"]>
  ): ReturnType<OverlayFs["symlink"]> {
    await this.whileGuarded([args[1]], async () => {
      this.chargeEntries(args[1], true);
      await super.symlink(...args);
      this.overlayFilePaths.add(this.normalize(args[1]));
    });
  }

  override async link(
    ...args: Parameters<OverlayFs["link"]>
  ): ReturnType<OverlayFs["link"]> {
    await this.whileGuarded([args[0], args[1]], async () => {
      const stats = await super.stat(args[0]);
      this.chargeEntries(args[1], true);
      if (stats.isFile) {
        this.reserve("overlay", stats.size);
      }
      await super.link(...args);
      this.overlayFilePaths.add(this.normalize(args[1]));
    });
  }

  override readlink(
    ...args: Parameters<OverlayFs["readlink"]>
  ): ReturnType<OverlayFs["readlink"]> {
    return this.whileGuarded([args[0]], () => super.readlink(...args));
  }

  override realpath(
    ...args: Parameters<OverlayFs["realpath"]>
  ): ReturnType<OverlayFs["realpath"]> {
    return this.whileGuarded([args[0]], () => super.realpath(...args));
  }

  override async utimes(
    ...args: Parameters<OverlayFs["utimes"]>
  ): ReturnType<OverlayFs["utimes"]> {
    await this.whileGuarded([args[0]], async () => {
      const stats = await super.stat(args[0]);
      const normalized = this.normalize(args[0]);
      this.chargeEntries(normalized, false);
      if (stats.isFile && !this.overlayFilePaths.has(normalized)) {
        this.reserve("overlay", stats.size);
      }
      await super.utimes(...args);
      if (stats.isFile) {
        this.overlayFilePaths.add(normalized);
      }
    });
  }

  override getAllPaths(): ReturnType<OverlayFs["getAllPaths"]> {
    return this.whileGuardedSync([virtualRoot], () => {
      const paths = super.getAllPaths();
      this.assertObservedPaths(paths);
      return paths;
    });
  }
}

const fileSystemFacade = (fileSystem: RequestBudgetOverlayFs): IFileSystem => {
  const facade: IFileSystem = {
    appendFile: (path, content, options) =>
      fileSystem.appendFile(path, content, options),
    chmod: (path, mode) => fileSystem.chmod(path, mode),
    cp: (source, destination, options) =>
      fileSystem.cp(source, destination, options),
    exists: (path) => fileSystem.exists(path),
    getAllPaths: () => fileSystem.getAllPaths(),
    link: (existingPath, newPath) => fileSystem.link(existingPath, newPath),
    lstat: (path) => fileSystem.lstat(path),
    mkdir: (path, options) => fileSystem.mkdir(path, options),
    mv: (source, destination) => fileSystem.mv(source, destination),
    readdir: (path) => fileSystem.readdir(path),
    readdirWithFileTypes: (path) => fileSystem.readdirWithFileTypes(path),
    readFile: (path, options) => fileSystem.readFile(path, options),
    readFileBuffer: (path) => fileSystem.readFileBuffer(path),
    readFileBytes: (path) => fileSystem.readFileBytes(path),
    readlink: (path) => fileSystem.readlink(path),
    realpath: (path) => fileSystem.realpath(path),
    resolvePath: (base, path) => fileSystem.resolvePath(base, path),
    rm: (path, options) => fileSystem.rm(path, options),
    stat: (path) => fileSystem.stat(path),
    symlink: (target, linkPath) => fileSystem.symlink(target, linkPath),
    utimes: (path, atime, mtime) => fileSystem.utimes(path, atime, mtime),
    writeFile: (path, content, options) =>
      fileSystem.writeFile(path, content, options),
  };
  return Object.freeze(facade);
};

const fileContentSize = (
  content: Parameters<OverlayFs["writeFile"]>[1],
  options: Parameters<OverlayFs["writeFile"]>[2]
) => {
  if (content instanceof Uint8Array) {
    return content.byteLength;
  }
  const encoding = typeof options === "string" ? options : options?.encoding;
  return Buffer.byteLength(content, encoding);
};
